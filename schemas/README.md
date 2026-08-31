# Understudy shared schemas

Versioned JSON Schemas for artifacts that cross surface boundaries (desktop
app, skills, CLI, ladder). One spine, adopted everywhere.

## Local workload eval authoring

The `understudy.eval-project.v2`, export-proof, execution-index-row, metric,
coverage, harness, environment, splits, check-fixtures, check-report, and approval schemas define the private
coding-agent workspace checked by `understudy evals check`. The workload
profile remains Markdown; its exact bytes are bound by both intent approval and
the deterministic check-input hash. These contracts require a provider-free
local environment replay, independent good/wrong evidence, explicit lineage
coverage, and a separate post-check owner approval.

The `understudy.eval-publication.v1` and `understudy.eval-release.v1` JSON
Schemas define the structural hosted boundary for this workflow. Publication
carries the checked hashes, final approval, executable layout, and bundle
inventory. The server response adds the immutable release seal. Neither
contract contains raw source traces, export proofs, or mutable authoring state.

These Draft 2020-12 schemas do not express the release contract's cross-field
path rules. Consumers must also parse publications with the package's exported
`EvalPublicationSchema` and releases with `EvalReleaseSchema`. Those semantic
validators require a unique, code-unit-sorted bundle inventory, every declared
artifact and entrypoint, disjoint executable roots, entrypoints inside their
declared roots, and no undeclared files outside the executable module trees.
The CLI applies them before upload and to every hosted response.

## Outcome-first replacement contracts

Four draft-2020-12 contracts form the fail-closed evidence boundary for an
outcome-first replacement run:

- [`understudy.source_binding.v1.schema.json`](understudy.source_binding.v1.schema.json)
  binds an opaque source id and sanitized fixture to explicit content hashes.
- [`understudy.verifier_calibration.v1.schema.json`](understudy.verifier_calibration.v1.schema.json)
  can pass only with hash-bound oracle=1, sentinel=0, replay, and distinct
  total-versus-consecutive malformed semantics.
- [`understudy.gepa_viz_manifest.v1.schema.json`](understudy.gepa_viz_manifest.v1.schema.json)
  exposes redacted live state, aggregate progress, cost, latency, and artifact
  references; running/completed manifests require source, calibration, train,
  and dev hashes.
- [`understudy.promotion_receipt.v1.schema.json`](understudy.promotion_receipt.v1.schema.json)
  records promotion or a truthful no-promotion terminal. `promoted` requires a
  freshly executed hash-bound holdout, passing serving parity, scored results,
  a compiled-policy reference, claim boundary, demotion trigger, and receipts.
  Dev-only or historically observed holdout evidence can never promote.

Unknown evidence is represented by required nullable fields rather than an
invented value. These schemas are deliberately closed: prompts, trace bodies,
source rows, secrets, and other private payloads must stay in referenced,
content-addressed artifacts. Costs and latency remain null unless a truthful
basis exists. Focused conformance cases live in
[`tests/outcome-first-contracts.test.mjs`](../tests/outcome-first-contracts.test.mjs).

## Portable environment proposals

[`understudy.proposal_environment.v1.schema.json`](understudy.proposal_environment.v1.schema.json)
binds a task, dataset adapter and split hashes, parser, verifier or stateful
environment, reward rubric, scripted oracle, reward-hacking sentinels, and
backend compatibility. Executability is deterministic: hashes, oracle=1,
sentinel rejection, reset reproducibility, leakage/live-effect boundaries,
useful nonconstant reward, and parser compatibility must pass. A Pi-authored
proposal remains `needs_verifier` until those probes exist and pass.

## Proof-scoped correction evidence

[`understudy.proof_correction_evidence.v1.schema.json`](understudy.proof_correction_evidence.v1.schema.json)
wraps one canonical `understudy.correction_pair.v1` row with immutable proof
identity, deterministic evaluator output, human-label provenance, and an
explicit training-eligibility decision. A deterministic exact-output score is
never represented as a human label.

[`understudy.proof_correction_export.v1.schema.json`](understudy.proof_correction_export.v1.schema.json)
is the content-addressed manifest for those rows. Promotion and smoke proofs
remain evaluation-only; only separately declared train or development splits
can become GEPA inputs, and incomplete token attribution fails eligibility.

[`understudy.proof_correction_gepa_samples.v1.schema.json`](understudy.proof_correction_gepa_samples.v1.schema.json)
and
[`understudy.proof_correction_gepa_handoff.v1.schema.json`](understudy.proof_correction_gepa_handoff.v1.schema.json)
define the local DSPy/GEPA projection. The projection binds every sample back
to its proof and correction evidence hashes, freezes a deterministic train/dev
split, excludes holdout rows, and records that preparation made no provider
call or upload.

## `understudy.desktop_grocery_report_package.v1`

[`understudy.desktop_grocery_report_package.v1.schema.json`](understudy.desktop_grocery_report_package.v1.schema.json)
binds a derived buyer report to the immutable grocery proof and exact renderer
that produced it. The manifest hashes `summary.json`, `results.jsonl`,
`tasks.json`, `report.json`, `report.html`, and the renderer source. Refreshing
an old proof therefore creates a new owner-only package instead of rewriting
evidence or silently presenting a stale report.

## `understudy.desktop_api.v2`

[`understudy.desktop_api.v2.openapi.json`](understudy.desktop_api.v2.openapi.json)
is the OpenAPI 3.1 contract for agents operating a running Understudy Desktop
app. It documents only the authenticated v2 operations currently implemented;
the extension metadata distinguishes model controls already available through
authenticated MCP/CLI from operations not yet versioned in REST.
`understudy desktop contract --json` prints the packaged document without
requiring Desktop to be running.

## `understudy.experiment.v1`

[`understudy.experiment.v1.schema.json`](understudy.experiment.v1.schema.json)
is one experiment-lineage record in a benchmark dir's `experiments.jsonl`
sidecar (append-only; newest line per `experiment_id` wins): data selection by
content hash, training method + config with explicit approval gates BEFORE any
provider spend, the produced artifact, baseline + eval run ids, and the final
promote/shadow/collect/stop verdict. Runs link back via the run request's
additive `experiment_id`. See
[`docs/experiment-lineage.md`](../docs/experiment-lineage.md).

## `understudy.eval_result.v1`

[`understudy.eval_result.v1.schema.json`](understudy.eval_result.v1.schema.json)
is the one row shape for eval evidence: one evaluated task attempt in a run.

### Adoption contract

Every surface that records or exports per-task eval results emits rows in this
shape:

- **Desktop app (Fusion benchmarks)** — recorded rows in the `fusion_benchmarks`
  SQLite table map 1:1 onto `eval_result.v1`, and
  `export_fusion_benchmark_comparison` packets carry an `eval_results` array of
  these rows alongside the existing summary shapes.
- **Onboarding ladder** — `skills/ladder/serve.py` persists one row per scored
  run as JSONL under `~/.understudy/ladder-runs/<run-id>.jsonl`.
- **Skills** — `capture-evidence`, `optimize-workload`, and
  `compare-model-sweep` require per-row eval evidence (baselines, sweeps, claim
  packets) to be recorded in this format.
- **CLI** — the `optimize-workload` proof-packet writer declares this schema as
  the expected row format in its evidence section.

Rules for producers and consumers:

1. **Run and attempt identity are different.** `run_id` groups every row from
   one benchmark invocation. `capture_run_id` identifies one task attempt and,
   when present, joins it to immutable canonical conversation-runtime JSONL.
   New Desktop benchmark rows always assign it; legacy rows may be null.
2. **Rows are additive-extensible.** Producers may attach extra fields
   (`additionalProperties: true`); consumers must ignore fields they do not
   understand. Never change the meaning of an existing field — that requires
   `eval_result.v2`.
3. **Most fields are nullable by design** so a producer can adopt the schema
   today with whatever it can compute, and enrich rows over time. Only
   `schema_version`, `run_id`, `task_id`, and `status` are required.
4. **A score of `0` is a scored failure**, never a missing value. Missing means
   `score: null`. UI code must use null checks, not truthiness.
5. **`status` semantics** (matching the desktop scorer): `ok` = executed and
   scored; `error` = the attempt failed to execute; `skipped` = never executed;
   `unscored` = executed but no rubric/gold covers the task, so the row must be
   excluded from score averages rather than counted as 0.
6. **Never invent prices.** `cost.usd` stays null unless a real price basis
   exists, and `cost.basis` must say what that basis is.
7. **Provenance chains are optional but standardized**: `harness_sha256` and
   `split_sha256` line up with the `harness_sha256` / `splits_sha256` hash
   chain the `capture-evidence` and `optimize-workload` skills already require
   in `baseline.json` and `claim.json`.

### Validation

The schema is standard JSON Schema (draft 2020-12). Repo tests use a
lightweight structural check (required fields, enums, score range) so no
validator dependency is needed; external consumers can use any draft-2020-12
validator.

## `understudy.training_evidence.v1`

[`understudy.training_evidence.v1.schema.json`](understudy.training_evidence.v1.schema.json)
is the smallest artifact that records a scored rollout as reusable training
evidence: one row is one **episode**, decomposed into **steps**, each carrying
the **candidate** generation(s), the **verifier outcome** per candidate, and
**optional token-logprob** records — plus split/holdout hashes, the source pin,
model/version, seed, terminal reward, latency/cost, and the privileged-context
boundary. The point is that **SFT, DPO, and GRPO all project from the same
row** without re-running the workload.

It aligns with the two contracts above: `eval_result.v1` (nullable,
additive-extensible rows; `split`/`status`/`cost` conventions; "a real 0 is a
scored value") and `verifier_handoff.v1`
(`splits_sha256`/`holdout_sha256`/`contamination`; terminal-by-default reward
with shaping explicit and optional).

Two safety gates bind every projection:

1. **Split gate** — training pools draw only from `split: "train"` (and, where
   a producer allows it, `"dev"`); `"holdout"` rows are return-eval evidence
   only and must never enter a pool.
2. **Privileged-context boundary** — `privileged_context.in_policy_input: true`
   marks a row whose trainable input carries privileged signal (gold/oracle/
   teacher/future state); the safe case is `verifier_only` (privilege scores a
   candidate, never shown to the policy). A `teacher`/`oracle` or
   `privileged: true` candidate may be a reward/reference source but never an
   SFT target or DPO `chosen` side.

This is a local evidence artifact and never triggers provider calls or spend —
hosted training that consumes the projected pool is authorized separately via a
`verifier_handoff.v1` packet. SFT/DPO/GRPO-safe usage and reference projectors:
[`docs/training-evidence.md`](../docs/training-evidence.md) and
`tests/training-evidence.test.mjs`.

## `understudy.route_decision_packet.v1`

[`understudy.route_decision_packet.v1.schema.json`](understudy.route_decision_packet.v1.schema.json)
is the route decision for one workload — written by the CLI planner
(`src/route-decision.ts`) and validated by `understudy routes promote` before
any field is consumed. `decision: "evaluate-first"` / `"local-only"` packets
must never mutate hosted traffic; promotion-grade packets should cite their
eval evidence (an app export packet path + `eval_results_sha256`, or a
`claim.json`) in the optional `evidence` block.

## `understudy.fusion_route_policy_export.v1`

[`understudy.fusion_route_policy_export.v1.schema.json`](understudy.fusion_route_policy_export.v1.schema.json)
is the desktop app's persisted Fusion route-decision evidence, carried in the
`route_policy` field of every `understudy.fusion_benchmark_comparison.v1`
export packet. It is the app-side counterpart a CLI route decision reconciles
against: per-prompt decisions with policy class, readiness signals, and
token/memory accounting.

### Export packet provenance

Every `understudy.fusion_benchmark_comparison.v1` packet also carries a
packet-level `provenance` block. The eval rows are written to a sibling JSONL
file (`provenance.eval_results_path`, one compact `eval_result.v1` row per
line) and `provenance.eval_results_sha256` is the SHA-256 of that file's bytes
— verify with `shasum -a 256 <file>`, the same file-hash idiom as
`harness_sha256`/`splits_sha256`. The block also surfaces row count and the
distinct run ids, split identities, row-level harness/split hashes, and cost
bases. Skills admit an app export as claim evidence by checking this block;
see `skills/ramp-and-verify/SKILL.md`.

## `understudy.benchmark.v1`

[`understudy.benchmark.v1.schema.json`](understudy.benchmark.v1.schema.json)
is the canonical benchmark manifest: a task taxonomy plus seeded task
instances, bound to one executable environment form (a verifiers-v1
environment package behind `environment.package_ref`) and one verifier
contract. Trace-derived, imported (Harbor, AutomationBench, Environments Hub,
inspect_ai, HF datasets), and hand-authored benchmarks are all first-class in
the same shape.

Adoption contract:

- The manifest is the durable Understudy-owned artifact; the compiled
  environment package is disposable and re-targetable. The upstream library
  pin lives in exactly one place (`environment.verifiers_version_pin`).
- Runs retain the `traces.jsonl` message DAG as drill-down evidence; each
  root-to-leaf branch projects to one `understudy.eval_result.v1` row carrying
  `benchmark_id`, `category_id`, and `trace_ref` as extension fields
  (`src/benchmark.ts`). Nothing downstream of the projection has to learn
  DAGs.
- Split/contamination discipline reuses the `verifier_handoff.v1` contract
  (`splits.splits_sha256`, `contamination`). Imported public benchmarks start
  `contamination: "unknown"` with a null `linked_eval` — viewers must render
  both as visible evidence warnings, never as first-class evidence.

## `understudy.benchmark_review.v1`

[`understudy.benchmark_review.v1.schema.json`](understudy.benchmark_review.v1.schema.json)
is one human review decision against a machine-proposed benchmark task from
the trace foundry: decision enum (`accept`, `restrict`, `needs_more`,
`reject`), a free-text note, and a timestamp. Reviews live as one JSON object
per line in an append-only `reviews.jsonl` file next to the foundry's
`manifest.json` (`understudy.trace_foundry.v1`); the newest line per
`task_id` supersedes older ones. `benchmark_id` is the foundry output
directory slug, not an `understudy.benchmark.v1` id — proposed benchmarks
have no promoted manifest yet. Viewers (e.g. `apps/benchmark-hub`) render
the latest decision everywhere the task appears and count review progress
from it.

## `understudy.benchmark_version.v1`

[`understudy.benchmark_version.v1.schema.json`](understudy.benchmark_version.v1.schema.json)
is one line of the `versions.jsonl` sidecar next to a promoted benchmark's
`benchmark.json` — the append-only version-history ledger (newest last)
behind the rerun/regrade/reuse contract. Required: `created_at`. Optional:
`version` (benchmark-level semver in force as of the line), `splits_sha256`,
`contamination` (`clean`/`contaminated`/`unknown`/null), `note`, and
`task_bumps[]` recording per-task `{task_id, bump (major|minor|patch), from,
to, reason}` — env changes bump MAJOR (rerun), verifier changes MINOR
(regrade), meta changes PATCH (reuse). Legacy split-freeze-only lines (no
`version`/`task_bumps`) stay valid; consumers ignore unknown fields.
Producers: first promote stamps the initial line (`src/trace-foundry.ts`);
`understudy benchmarks upgrade` appends one line per version bump
(`src/benchmark-upgrade.ts`). Consumers: the hub's leaderboard staleness
(`src/benchmark-staleness.ts`) and the rigor CI contamination check.

## `understudy.benchmark_flag.v1`

[`understudy.benchmark_flag.v1.schema.json`](understudy.benchmark_flag.v1.schema.json)
is one human quality flag against a benchmark or one of its tasks: reason enum
(`bad-gold`, `ambiguous`, `leakage`, `too-easy`, `broken-env`, `other`), a
free-text note, and an `open`/`resolved` status. Flags live as one JSON object
per line in a `flags.jsonl` file next to the benchmark's `benchmark.json`
manifest. `task_id: null` flags the whole benchmark. Viewers (e.g.
`apps/benchmark-hub`) badge flagged units everywhere they appear and let
leaderboards exclude open-flagged tasks; only `open` flags affect exclusion.

## `understudy.app_harness.v1`

[`understudy.app_harness.v1.schema.json`](understudy.app_harness.v1.schema.json)
is the `app-harness.json` sidecar in a benchmark directory: how the run
executor launches the user's OWN application per frozen task for the
`app_replay` arm (`src/app-harness.ts`). It carries the launch argv, cwd,
extra env, input mode (`argv` / `stdin` / `http`), per-task timeout, and the
declared LLM/tool routes. The executor injects the gateway redirect env vars
(the `/instrument` pattern) so the app's LLM calls route through the
Understudy gateway, and scores observed tool events through the shared
contract scorer. Tier-1 boundary: rollouts whose tool effects are not
observable are recorded with the `app_replay_unobserved` anomaly — honest
partial evidence, never fabricated scores. Authoring guide:
[`docs/app-harness.md`](../docs/app-harness.md).
