# Experiment lineage (`understudy.experiment.v1`)

Real experiments — the UND-289 Instacart SFT decision is the reference shape —
link **data selection → training config → approval gates → checkpoint → eval
runs → verdict** only in prose. `experiments.jsonl` makes that chain
machine-readable using the repo's established sidecar pattern
(`reviews.jsonl` / `feedback.jsonl` / `calibration.json`).

## The sidecar

- **File:** `<benchmark-dir>/experiments.jsonl`, next to `manifest.json` /
  `benchmark.json`. Works for proposed AND promoted benchmarks.
- **Rule:** append-only; one `understudy.experiment.v1` JSON object per line;
  the **newest line per `experiment_id` wins** (same superseding rule as
  `reviews.jsonl`). Updates append the FULL merged record — history is never
  rewritten.
- **Schema:** [`schemas/understudy.experiment.v1.schema.json`](../schemas/understudy.experiment.v1.schema.json).
- **Code:** constants + codec (`makeExperiment`, `appendExperiment`,
  `readExperiments`, `latestExperiments`, `validateExperiment`) live in
  `src/benchmark-artifacts.ts`; entry-gated write ops (`createExperiment`,
  `updateExperiment`, `listExperiments`, `experimentsSummary`) in
  `src/benchmark-hub-core.ts`. The CLI and MCP tools both call these — one
  implementation, never forked.

## Record shape (the und-289 mapping)

| Field | und-289 example |
| --- | --- |
| `hypothesis` | "full-parameter SFT on qwen3-8b reaches ≥90% exact L3 on the frozen holdout" |
| `status` | `draft` → `training` → `evaluating` → `concluded` \| `abandoned` |
| `data_selection.selection_hash` | the curate-trajectories selection hash of the 4,272/546/559 grouped split |
| `data_selection.source` | "instacart shopper high-confidence CSV (5,377 rows post-dedup)" |
| `data_selection.splits_sha256` | sha256 of the frozen split artifact |
| `training` | `{method: "sft", base_model: "qwen3-8b", provider: "fireworks", config: {max_context_length: 1024, class_weights: "clip(sqrt(...), 0.5, 4.0)", …}, cost_estimate: {short_prompt_usd: 3, fuse_usd: 25}}` |
| `training.approvals` | `[{gate: "consensus_audit", …}, {gate: "customer_data_upload", …}, {gate: "provider_training_spend", …}]` |
| `produced_artifact` | `{kind: "checkpoint", ref: "<fireworks model id>", sha256: "…"}` |
| `baseline_run_id` | the frozen `gemma-4-31b-it` incumbent run |
| `eval_run_ids` | holdout eval runs of the checkpoint |
| `verdict` | `{decision: "promote" \| "shadow" \| "collect" \| "stop", summary, decided_at}` |

**Approval gates are first-class.** `training.approvals` records gates already
CLEARED, in order, and appends monotonically across superseding lines (a patch
can add gates, never drop them). A consumer must refuse to upload customer
data or create a provider job while the corresponding gate entry
(`customer_data_upload`, `provider_training_spend`, …) is absent. The record
itself never spends — it is lineage, not a launcher.

## Surfaces

CLI (JSON in / JSON out; `--input` accepts inline JSON or `@file`):

```sh
understudy benchmarks experiment create <dir> --input '{"hypothesis": …, "data_selection": …, "training": …}'
understudy benchmarks experiment update <dir> <experiment_id> --input '{"status": "training", "training": {"approvals": [ … ]}}'
understudy benchmarks experiment list <dir>
understudy benchmarks experiment show <dir> <experiment_id>
```

MCP (`understudy benchmarks mcp`): `create_experiment`, `update_experiment`,
`list_experiments`; `read_benchmark` additively surfaces
`experiments: {count, latest: [{experiment_id, status, decision, summary}]}`.

## Run linkage (`experiment_id` on the run request)

`queue_run` / `queueOrCancelRun` accept an additive `experiment_id`. It is

1. shape-validated in `validateRunRequestInput` (`[A-Za-z0-9_.-]+`),
2. existence-checked against the benchmark's `experiments.jsonl` (404 when the
   experiment does not exist — create it first), and
3. passed through `createRunRequest` onto the persisted
   `understudy.run_request.v1` file.

No executor change: eval rows and `runs/events.jsonl` entries already carry
`run_id`, so any consumer joins **row/event → run_id → run request →
experiment_id → experiment**. Close the loop the other way by appending the
run to the experiment: `update_experiment … {"eval_run_ids": ["run-…"]}`
(append-only union). Old executors ignore the field harmlessly — it is pure
provenance, so it deliberately adds no `requires` capability.

## Where the inputs come from

- **`data_selection.selection_hash`** — the `curate-trajectories` skill stamps
  every contamination-checked selection with a content hash; record that hash
  (and the frozen-split sha256) here so the train pool is auditable against
  the benchmark's dev/holdout freeze.
- **`training.config` / `cost_estimate`** — the `plan-hosted-run` skill's
  plan/preview/cost artifacts (provider, token math, fuse amounts) drop
  straight into `training.config` and `training.cost_estimate`; its approval
  graph maps to `training.approvals` gates.
- **`produced_artifact`** — the `local-distillation-lab` skill's trained
  checkpoints/adapters (or a hosted provider's model id) become
  `{kind, ref, sha256}`.
- **`baseline_run_id` / `eval_run_ids`** — queue runs through the hub or the
  benchmarks MCP with `experiment_id` set, then append the resulting run ids
  via `update_experiment`.
- **`verdict`** — the distill-classifier four-way
  (promote / shadow / collect / stop) with the evidence summary and timestamp.
