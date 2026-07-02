# Understudy shared schemas

Versioned JSON Schemas for artifacts that cross surface boundaries (desktop
app, skills, CLI, ladder). One spine, adopted everywhere.

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

1. **Rows are additive-extensible.** Producers may attach extra fields
   (`additionalProperties: true`); consumers must ignore fields they do not
   understand. Never change the meaning of an existing field — that requires
   `eval_result.v2`.
2. **Most fields are nullable by design** so a producer can adopt the schema
   today with whatever it can compute, and enrich rows over time. Only
   `schema_version`, `run_id`, `task_id`, and `status` are required.
3. **A score of `0` is a scored failure**, never a missing value. Missing means
   `score: null`. UI code must use null checks, not truthiness.
4. **`status` semantics** (matching the desktop scorer): `ok` = executed and
   scored; `error` = the attempt failed to execute; `skipped` = never executed;
   `unscored` = executed but no rubric/gold covers the task, so the row must be
   excluded from score averages rather than counted as 0.
5. **Never invent prices.** `cost.usd` stays null unless a real price basis
   exists, and `cost.basis` must say what that basis is.
6. **Provenance chains are optional but standardized**: `harness_sha256` and
   `split_sha256` line up with the `harness_sha256` / `splits_sha256` hash
   chain the `capture-evidence` and `optimize-workload` skills already require
   in `baseline.json` and `claim.json`.

### Validation

The schema is standard JSON Schema (draft 2020-12). Repo tests use a
lightweight structural check (required fields, enums, score range) so no
validator dependency is needed; external consumers can use any draft-2020-12
validator.

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
