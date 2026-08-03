# Qwen serverless verifier-RL lane

This lane is a reproducible, base-model-agnostic executor surface for
verifier-RL experiments against the synthetic
`automationbench-simple-api-offline-v2` fixture. The intended candidate method
is base → SFT on tool failures → GRPO, with every score using the shared
AutomationBench action protocol and offline verifier.

## Architecture buckets

- **verifier/contract**: `src/automationbench-action-protocol.ts` and
  `experiments/qwen-serverless-verifier-rl/serving-contract.qwen3p6-27b.json`.
  TypeScript owns the parser, protocol, fixture, and verifier.
- **executor**: `serving_shim.py` and `verifier_rl.py`. These are isolated
  `uv run --no-project` Python glue for Fireworks serverless attach/train/sample
  operations. They are not a controller, poller, queue, or state database.
- **candidate-method**: base → failure-directed SFT → GRPO.
- **UI-artifact**: receipts, redacted event streams, reports, manifests, and
  `partial-run-summary.json` under `outputs/qwen-serverless-verifier-rl/`.

Vercel Workflow is the sole durable experiment controller. The executor
interface is intended to be consumed by that Workflow.

## Executor submit conformance

The executor implements the canonical TypeScript surface in
[`src/executor-contract.ts`](../src/executor-contract.ts). Its strict
`ExecutorSubmitRequestSchema` contains only:

- experiment identity and attempt;
- candidate identity, executor, model, and hashed policy reference;
- workload identity, dataset manifest reference/hash, and verifier identity;
- hashed train and dev split manifest references;
- execution limits.

The payload structurally cannot carry a holdout reference or hash. Raw prompts,
traces, completions, labels, credentials, and weights are not payload fields.
The deterministic `(experiment_id, candidate_id, attempt)` key remains only in
the executor job reference for retry rebinding; it is not an extra submit
payload field. Provider session/run identifiers, snapshots, retry state, and
status belong to executor receipts/job references, not the canonical submit
request.

The Python adapter's emitted submit request is validated against
`ExecutorSubmitRequestSchema` directly in the provider-free contract tests.
The repository JSON schema remains covered as a wire/schema regression guard;
the TypeScript surface is the source of truth for job references, statuses,
cancellation receipts, and usage receipts. `ExecutorJobRefSchema` is where the
deterministic idempotency key lives; it remains absent from the strict submit
request.

`cancel` emits an `ExecutorCancellationReceiptSchema` receipt after invoking
the adapter cancellation path. `reconcileUsage` emits an
`ExecutorUsageReceiptSchema` with `evidence_scope: "run_exclusive"`,
`actual_usd: null`, `estimated_usd: null`, and the client-side number in
`upper_bound_usd`. The accompanying note says that the ledger uses client-side
token counts and uncached-prefill pricing and is not provider-authoritative
billing.

## Session concurrency finding

The Fireworks probe found no failure during sequential idle delays:

| Idle delay | Attach | Save snapshot | Sampling client | Result |
|---:|---:|---:|---|---|
| 0s | success | success | success | success |
| 30s | success | success | success | success |
| 120s | success | success | success | success |
| 300s | success | success | success | success |

A concurrent five-session probe produced two successes and three
`404 NOT_FOUND ... TrainingSession ... not found` failures. The evidence points
to concurrent/leaked session capacity rather than idle expiry. The executor
therefore permits at most one live training session per process and closes it
deterministically.

## Aborted partial run

The paid run was stopped before any further training phase. P0 attached a base
snapshot and scored dev plus a deterministic train stride-2 subset. P0b could
not run against the inference API because the base model returned HTTP 404.
Oracle export completed for the 60 failed train-subset task IDs. P1 SFT
attached but stopped before optimizer work on a deterministic tokenizer/template
assertion. No GRPO, band report, holdout, or Nemotron comparison ran.

The measured client-side P0 ledger was:

| Kind | Tokens |
|---|---:|
| Prefill | 172,746 |
| Cached | 0 |
| Sample | 46,798 |
| Train | 0 |

The uncached-prefill upper-bound estimate was **$0.58314237**. This is not a
provider-authoritative billing total.

Holdout remains `clean`, never executed, with its run-once flag set. See
`outputs/qwen-serverless-verifier-rl/partial-run-summary.json`.

## Harness defect and invalid P0 numbers

The P0 reports are explicitly marked `invalid_harness_defect` and
`claimable_baseline: false`. Their observed zero means are not a Qwen
capability measurement.

No raw completion text was retained in the zeroshot reports, shim logs, or
event streams; only token counts and per-task outcomes were preserved. That is
a harness observability gap.

The evidence that identifies the defect is:

- every episode ended malformed;
- each episode consumed exactly three 128-token completions under the
  malformed tolerance;
- the model was generating tokens, but never reached a parseable action;
- the independent SFT path hit the same Qwen chat-template assistant-prefix
  assertion.

The serving path was decoding with `skip_special_tokens=False`, and the live
commands overrode the contract's 512-token default with 128 tokens. Qwen's
reasoning/template markers therefore consumed the short response budget and
left no complete JSON object. The shim now decodes with
`skip_special_tokens=True`; the shared parser also removes terminal special
tokens, and a local regression test covers a Qwen-style
`<think>...</think>{...}<|im_end|>` completion. The deterministic
chat-template rendering assertion was also corrected to construct assistant
segments from rendered text rather than assuming incompatible token-prefix
boundaries.

No provider job was rerun after these fixes.

## Claim boundary

This evidence supports only:

- the offline fixture, protocol, hash, and artifact-contract implementation;
- the session-concurrency characterization;
- the partial client-side cost upper bound;
- the fact that the captured P0 attempt was invalid due to a serving harness
  defect.

We are **not** entitled to claim:

- a Qwen base capability score;
- a base → RL lift;
- an SFT or GRPO improvement;
- a Qwen-vs-Nemotron/Tinker head-to-head result;
- provider-authoritative spend;
- any holdout result.

All examples and artifacts use the synthetic fixture only.
