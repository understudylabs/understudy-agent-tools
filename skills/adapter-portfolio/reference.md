# Adapter Portfolio Reference

## Unified Workflow contract

This module maps to the verifier/contract layer of the unified Workflow
runtime. `evaluateAdapterPortfolioStep` accepts
`experiment_id`, `candidate_id`, `attempt`, an explicit `evaluated_at`, and
the registry value (or an artifact URI/SHA-256 paired with its already-loaded
value). It performs no I/O, network access, polling, controller work, or
filesystem writes. The CLI may load the local JSON artifact, but the Workflow
step receives the value directly and treats the registry artifact reference as
the authoritative identity.

The output is an immutable `understudy.adapter_promotion_decision.v1` artifact
with the canonical idempotency key
`<experiment_id>:<candidate_id>:<attempt>`, matching the executor boundary's
retry convention. It is derived from `(experiment_id, candidate_id, attempt)`.
Its `inputs` records the registry URI/hash, candidate sealed-holdout
URI/hash/row count, and consumed evidence IDs. A retry with the same inputs is
byte-identical. Workflow code can write the returned `promotionEvents(...)`
array through its `getWritable()` stream: it uses the platform event shape
(`schema_version`, sequence, `run_id`, phase, type, and bounded scalar
details), with one redacted event per check and one terminal decision event.

Only references, hashes, IDs, scores, and bounded scalar statuses cross this
boundary. Raw traces, prompts, labels, credentials, and weights are forbidden.
Evidence `notes` is limited to a redacted summary of at most 500 characters.
This module performs no provider or paid work, so it has no
submit/inspect/cancel/reconcileUsage surface.

## Canonical executor boundary

The canonical executor submit contract is `understudy.executor-submit.v1`.
Its required submit fields are:

- `experiment_id` and non-negative `attempt`;
- `candidate`: `candidate_id`, executor kind, model, `policy_ref`, and
  `policy_sha256` (with optional `model_revision`);
- `workload`: `id`, `dataset_manifest_ref`,
  `dataset_manifest_sha256`, `verifier_environment`, and
  `verifier_revision`;
- `splits`: `train_manifest_ref`, `train_manifest_sha256`,
  `dev_manifest_ref`, and `dev_manifest_sha256`;
- `limits`: `budget_usd`, `max_concurrent_candidates`,
  `max_concurrent_requests_per_candidate`, `max_rollouts`, and
  `max_runtime_seconds`.

The optional adapter-record `workload` and `splits` fields mirror those
canonical names and semantics exactly. `workload.id` is the natural
identity carrier alongside this registry's `suite`; the verifier identity
and revision live in `verifier_environment` and `verifier_revision`.
`workflowIdentityRefs(...)` exposes only these workload and train/dev
manifest references for boundary integration. It does not construct or emit
a submit payload.

The portfolio's sealed `holdout`, holdout evidence rows, hashes, row counts,
and scores are structurally absent from that identity projection and must
never cross into a submit request. Holdout refs remain exclusively in the
promotion decision artifact and verifier gate.

New adapter records initialize `holdout_executed: false` and
`holdout_clean: true`. The gate refuses promotion when the holdout is marked
executed or its cleanliness is not explicitly confirmed. Evidence rows may
carry the executor-reported `evidence_scope` (`run_exclusive`,
`account_window`, or `unknown`); the portfolio preserves it and does not
reinterpret it. The no-forgetting context is also the portfolio's
request-isolation evidence: baseline rows exclude the candidate from
`loaded_adapters`, and rechecks include it.

The decision artifact optionally records canonical quality/calibration status,
calibration artifact refs, failure clusters, artifact refs, a claim boundary,
and whether request isolation was proven. These are verifier-owned evidence
summaries, not raw content. Budget and actual/estimated/upper-bound usage
remain executor-owned because this module performs no provider work and does
not reconcile usage.

Executor adapters, not this verifier/contract module, own `submit`, `inspect`,
and `cancel`. Cancellation must reach the adapter and produce a
`ExecutorCancellationReceipt` (recorded in the run's
`cancellation_receipts`) with the job identity, disposition, and observation
time. Usage reconciliation also belongs to the adapter and reports an
explicit `evidence_scope` (`run_exclusive`, `account_window`, or `unknown`);
this module does not infer, hardcode, or reconcile usage.

The base-model transfer set contains one base reference for each suite in the
union of the candidate suite and every currently promoted adapter's suite.
Each reference is a `subject: "base"` holdout row with no candidate in
`context.loaded_adapters`.

Each previously promoted adapter contributes one reference on its own suite:
`subject: "adapter"`, `adapter_name` equal to that adapter, and `split:
"holdout"`. The candidate must then have a later recheck row for every
reference with the candidate name in `context.loaded_adapters`.

The candidate's own dev and holdout rows are adapter-subject rows on its
registered suite. Dev selects the best recorded candidate row, but holdout
selection is deliberately worst-of-N: if the candidate has multiple holdout
runs, the lowest score is used and the gate says so explicitly. This prevents
re-running a sealed holdout and cherry-picking a favorable result. The
holdout row must use the exact recorded holdout SHA-256 and row count. The
recorded timestamp is also used to enforce that dev came before holdout.

The exact no-forgetting baseline set is:

- one base holdout reference for every suite in the candidate suite plus every
  currently promoted adapter's suite;
- one holdout reference for each currently promoted adapter on that adapter's
  own suite.

References exclude the candidate from `context.loaded_adapters`. Each baseline
requires a later recheck with the candidate loaded, and the recheck may not
fall below the reference by more than `max_regression`. The candidate's
`min_lift_vs_base` requirement applies to both dev and holdout when an
uncontaminated base row exists.

Example:

```bash
understudy adapter-portfolio init \
  --min-dev-score 0.80 \
  --min-holdout-score 0.78 \
  --max-regression 0.02

understudy adapter-portfolio register \
  --name adapter-a \
  --path ./artifacts/adapter-a \
  --base base-model \
  --suite workload-band-a \
  --method sft-lora \
  --holdout-path ./splits/holdout.jsonl \
  --holdout-sha256 <64-hex-sha256> \
  --holdout-rows 40

understudy adapter-portfolio candidate adapter-a

understudy adapter-portfolio evidence add \
  --adapter adapter-a --suite workload-band-a --split dev \
  --score 0.84 --metric score --dataset-sha256 <64-hex-sha256> \
  --rows 80 --seed 7

understudy adapter-portfolio evidence add \
  --adapter adapter-a --suite workload-band-a --split holdout \
  --score 0.81 --metric score --dataset-sha256 <holdout-sha256> \
  --rows 40 --seed 7

understudy adapter-portfolio gate adapter-a --json
understudy adapter-portfolio promote adapter-a --dry-run --json
```

Serving names may be placed in `loaded_adapters`; the portfolio does not
configure serving endpoints or placement.
