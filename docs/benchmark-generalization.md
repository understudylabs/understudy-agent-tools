# Cross-group generalization

## Problem

Training can improve a model on the task group used to train it without
improving other work. This harness compares baseline and tuned
`understudy.eval_result.v1` rows, measures paired per-task changes, and reports
whether gains transfer across an explicit group taxonomy. It is evaluator
agnostic: Prime/Verifiers, trace-foundry environments, app-harness rows,
AutomationBench projections, and future sanitized synthetic rows all use the
same input contract.

The analysis is offline and pure over rows. It never runs a provider, reads
provider receipts for scores, or makes network calls.

## Group taxonomy

### A: AutomationBench

This checkout does **not** contain `src/automationbench-offline.ts`. The current
in-repo surface is the imported projection at
`experiments/benchmark-hub-demo/automationbench-import/project-rows.mjs`,
which uses `normalizeTraceRecord`, `extractBranches`, and
`projectBranchesToEvalRows` from `src/benchmark.ts`. Imported task IDs use a
domain/family shape such as `sales.multi_hop_lookup`; the fixture contains
Sales, Marketing, Operations, Support, Finance, and HR domains. The projection
converts externally produced per-task scores into shared eval rows.

### B: Existing verifier environments

The existing reusable environment/scoring spine is:

- `src/trace-foundry.ts`: generated subprocess Verifiers environments,
  `writeVerifiersEnvironment`, `scoreContract`, `scoreState`, and replay/oracle
  helpers. Generated packages contain `environment/`, `tasks.json`, fixtures,
  and scorer-side gold.
- `src/run-executor.ts`: `runVerifiersArm`, `verifiersRunner`, and
  `projectVerifiersTrace`; executes Python/Verifiers-style subprocesses and
  writes shared eval rows.
- `src/prime-benchmark-import.ts` and `src/prime-benchmark-runner.ts`:
  native Prime/Verifiers traces and their task/verifier/version identity.
- `schemas/understudy.app_harness.v1.schema.json`: replay of a user's app,
  with honest unobserved/anomaly rows when effects cannot be observed.
- `src/run-executor.ts`: oracle, null-agent, spam-agent, and majority-class
  calibration arms.

### C: Sanitized partner synthetic fixtures

The forthcoming sanitized partner synthetic fixture family is represented in a generalization manifest as
`{status: "planned"}` with a prefix or pattern match. A planned group with no
rows is first-class and produces `planned` matrix cells and coverage metadata,
not fabricated zero scores.

## Manifest and report

The input schema is
`schemas/understudy.generalization_manifest.v1.schema.json`. It pins:

- `frozen_split_sha256`
- evaluated splits (default: `holdout`)
- groups, by explicit task IDs or match predicates
- one or more training arms, each with baseline and candidate row paths
- optional `epsilon` and `regression_threshold`

Explicit `task_ids` take precedence over match predicates. Otherwise each row
must match zero or one group; matching two groups is a hard error, while
unassigned IDs are reported in `coverage.unassigned_task_ids`.

The output schema is
`schemas/understudy.generalization_report.v1.schema.json`. It echoes the
manifest, records each arm's task deltas, provides the transfer matrix, score
components, coverage, warnings, and candidate receipt paths.

## Frozen holdout and content rules

Every holdout row must carry
`provenance.split_sha256 === manifest.frozen_split_sha256`. Missing or
mismatched hashes stop the whole analysis with the run ID and task ID. This
prevents a result from being presented as a score on a different or mutable
holdout.

For each paired task, baseline and candidate rows must agree on
`provenance.task_content_hashes.env_sha256` and `verifier_sha256`. Metadata
hash drift is intentionally ignored, matching `src/benchmark-staleness.ts`.
Candidate and baseline must also have exactly the same task-ID coverage within
each evaluated group.

## Matrix and score definitions

Rows are filtered to the manifest's evaluated splits. A task's score is the
mean of its `status: "ok"` rows with numeric scores; `unscored` and `skipped`
rows do not enter means, and `error` rows do not enter means but are surfaced
through `error_rate`. Multiple attempts retain their scored rollout count.
Cells also retain candidate error rates by evaluated split for diagnostics.

Per-task delta is:

```text
candidate mean - baseline mean
```

The outcomes are `fixed`, `regressed`, and `unchanged`, using `epsilon`, with
the same vocabulary as `src/prime-benchmark-compare.ts`.

Each matrix row is a training arm. Each column is an evaluated group. A cell is
in-domain when its column is in the arm's `train_groups`; otherwise it is a
transfer cell. Cells contain paired task counts, means, delta, outcome counts,
error rate, and a deterministic paired bootstrap 95% interval. The bootstrap
uses a local seeded linear-congruential generator, seed `1729`, and `1000`
iterations by default.

The score block is explicit:

- `in_domain_gain`: task-weighted mean of all diagonal per-task deltas.
- `transfer_gain`: task-weighted mean of all off-diagonal per-task deltas.
- `transfer_ratio`: `transfer_gain / in_domain_gain`, or null when
  `in_domain_gain <= 0`.
- `forgetting`: the most negative off-diagonal scored group-cell delta.
- `regressed_groups`: off-diagonal cells below `regression_threshold`.
- `generalization_score`: with
  `p = clamp(max(0, -forgetting / regression_threshold), 0, 1)`,
  `clamp(transfer_ratio, 0, 1) * (1 - p)`. It is null when the transfer ratio
  is null.

This is a compact descriptive summary, not a promotion gate. It is sensitive
to group selection, task weighting, small samples, and the arbitrary
regression penalty. Coverage must always be read alongside the score.

## How a provider run should emit rows

Tinker or Fireworks-managed evaluations must stamp every row with:

- `run_id`: the training/evaluation run identity;
- `model`: resolved baseline or candidate model ID;
- `task_id`;
- `split`;
- `score` and `status` using the shared semantics (`0` is a scored failure,
  `null` is unscored/skipped, and execution failure is `error`);
- `provenance.split_sha256`: the frozen hash from the training plan's
  `split_hash`/`heldout_sha256` lineage;
- `provenance.task_content_hashes.env_sha256` and `verifier_sha256`;
- `provenance.artifact_refs`: paths or IDs pointing at the receipt and
  supporting artifacts.

The candidate manifest may record a Tinker manifest or Fireworks/train-api
workflow receipt in `candidate.receipt`. The harness records that path for
provenance only; it never parses provider receipts for scores.
