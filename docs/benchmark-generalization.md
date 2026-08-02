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

The primary in-repo evaluator is `src/automationbench-offline.ts`, a synthetic
offline implementation of the AutomationBench `simple/api` subset. It contains
12 task families with 6 instances each: 72 tasks total, split positionally
into 48 train, 12 dev, and 12 holdout tasks. Task IDs have the form
`simple-api-<family-slug>-<NN>`, with `NN` identifying the zero-padded
instance.

The evaluator exposes `evaluateSplit`, `oraclePolicy`, `sentinelPolicy`, and
`importSubset`. The scripted oracle and reward-hacking sentinel make
deterministic local baseline/candidate rows possible without providers. The
thin adapter in `src/generalization-automationbench.ts` binds group A to
`benchmark_id: "automationbench-simple-api-offline"` while keeping the
generalization core evaluator-agnostic.

`taskPool({ split: "holdout", frozenHoldoutSha256 })` fails closed unless the
hash equals `splitSha256("holdout")`. The adapter exports
`automationbenchFrozenHoldoutSha256()` for manifest authors. For an A-only
run, `manifest.frozen_split_sha256` must equal that value. Evaluated rows stamp
`provenance.split_sha256` from `splitSha256(split)`,
`provenance.harness_sha256` from `fixtureSha256()`, and a fixture artifact
reference.

#### Secondary adapter: imported projection

Externally produced AutomationBench scores can still be folded into the same
row contract through `importSubset` and
`experiments/benchmark-hub-demo/automationbench-import/project-rows.mjs`.
That path uses the shared `projectBranchesToEvalRows` projection helpers and
is secondary to the local evaluator; both paths feed
`understudy.eval_result.v1` rows.

### B: Existing verifier environments

The offline Group B adapter is the synthetic Event Categorizer verifier
example in
`skills/design-simulated-environment/examples/event-categorizer/`. Its
`tasks.jsonl` contains 12 invented tasks and `playbook.md` is the system
prompt. `src/event-categorizer-offline.ts` loads that fixture directly in
TypeScript, assigns the seed-7 positional split (8 train / 2 dev / 2 holdout),
and exports `scoreCompletion`, `taskPool`, `splitSha256`, and `fixtureSha256`.
The primary score is the Python example's `category_correct` rubric
(category 0.7 plus priority 0.3); `structured_output_ok` and `nonempty_ok`
are reported as subscores. No Python process, network, or live tool execution
is needed.

Other existing verifier spines remain separate:

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

The merged `src/synthetic-workflow-offline.ts` fixture is Group C:
`synthetic-workflow-shapes-offline`, nine invented tasks split 5 train / 2 dev /
2 holdout. It supplies the same deterministic reset/step/rollout API as Group A
and is registered by `src/generalization-registry.ts`.

## Manifest and report

The input schema is
`schemas/understudy.generalization_manifest.v1.schema.json`. It pins:

- `frozen_split_sha256`
- evaluated splits (default: `holdout`)
- groups, by explicit task IDs or match predicates
- one or more training arms, each with baseline and candidate row paths
- optional `epsilon` and `regression_threshold`
- optional `require_content_hashes` and `require_all_groups_scored`
- per-group `frozen_split_sha256` and `expected_task_counts`
- per-arm `eval_splits` (an array, or a group-to-splits map when an arm covers
  different scopes)

Explicit `task_ids` take precedence over match predicates. Otherwise each row
must match zero or one group; matching two groups is a hard error, while
unassigned IDs are reported in `coverage.unassigned_task_ids`.

The output schema is
`schemas/understudy.generalization_report.v1.schema.json`. It echoes the
manifest, records each arm's task deltas, provides the transfer matrix, score
components, coverage, warnings, and candidate receipt paths.

## Frozen holdout and content rules

Every holdout row must carry
`provenance.split_sha256 === group.frozen_split_sha256` when the group declares
one, otherwise the manifest-level hash. Missing or mismatched hashes stop the
whole analysis with the run ID and task ID. This
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

The offline AutomationBench evaluator is the reference row producer for these
stamps: `split_sha256` comes from `splitSha256(split)` and
`harness_sha256` comes from `fixtureSha256()`. A real provider run should mirror
that provenance shape, including the frozen holdout hash and task content
hashes where available.

The candidate manifest may record a Tinker manifest or Fireworks/train-api
workflow receipt in `candidate.receipt`. The harness records that path for
provenance only; it never parses provider receipts for scores.

## Provider-neutral model runner

`src/generalization-model-runner.ts` drives all three groups with the same
text-only protocol. The prompt requires one JSON object per turn:

```json
{"tool":"api_search","arguments":{}}
{"tool":"api_fetch","arguments":{}}
{"tool":"finish"}
```

The supported direct transports are Anthropic Messages
(`ANTHROPIC_API_KEY`) and Fireworks OpenAI-compatible chat completions
(`FIREWORKS_API_KEY`). Temperature is fixed at zero. Transport retries are
bounded to three attempts for 429/5xx responses. A `BudgetLedger` reserves
estimated cost before accepting each response and throws before exceeding the
caller-provided cap. Receipts contain one JSONL record per call with run/task
identity, token counts, latency, status, and estimated USD; a final summary
record contains aggregate calls, tokens, and cost.

The thin CLI entry point is:

```text
understudy benchmarks generalization-run \
  --group event-categorizer --model <id> --provider anthropic \
  --splits train,dev,holdout --out rows.jsonl --receipts receipts.jsonl \
  --budget-usd 15 --price-input 1 --price-output 5
```

`src/generalization-registry.ts` is the canonical group registry and manifest
builder. A tuned arm only needs to provide a rows file, model ID, and optional
receipt; its rows must use the same task IDs and task-content hashes as the
baseline.

## Current zero-shot matrix

The checked-in synthetic-task run is under
`experiments/generalization-transfer-matrix/`. It compares
`accounts/fireworks/models/gpt-oss-20b` with
`claude-haiku-4-5-20251001` over A dev+holdout, B all splits, and C all splits.
The rendered report is
`experiments/generalization-transfer-matrix/report.md`; the current cells are:

| Arm | AutomationBench | Event Categorizer | Synthetic workflows |
| --- | ---: | ---: | ---: |
| zeroshot-haiku-vs-gptoss | +0.410 (n=24) | +0.258 (n=12) | +0.148 (n=9) |
| mechanism-demo | +1.000 (n=72) | -0.400 (n=12) | -0.074 (n=9) |

The mechanism row is deliberately a weak-scripted baseline versus an
oracle-on-A/degraded-on-B-and-C candidate. It exercises negative transfer and
the forgetting penalty; it is not a model result and is excluded from the
top-level score. Scores are reported per arm before the aggregate, so a
mechanism demo cannot contaminate the zero-shot headline.

The corrected run uses a group-specific zero-shot scope: AutomationBench
dev+holdout, Event Categorizer all splits, and Synthetic Workflow all splits.
The manifest records this as an `eval_splits` map while the registry's full
expected counts remain authoritative for every declared split. Receipts record
estimated provider cost using the explicit caller-supplied list-price
assumptions; they are not billing statements.

<!-- GENERATED RECEIPTS START -->
## Run receipts

The following accounting is generated from the checked-in receipts and rows. USD values are estimates, not bills, using the stated price assumptions.

| Model | Calls | Prompt tokens | Completion tokens | Estimated USD | Transport-error rate | Price assumption |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Fireworks gpt-oss-20b | 132 | 67,271 | 20,644 | $0.014985 | 0.0% | $0.10 input / $0.40 output per 1M tokens |
| Anthropic Haiku 4.5 | 189 | 180,871 | 26,905 | $0.315396 | 0.0% | $1 input / $5 output per 1M tokens |

Share of rows with at least one parse failure:

| Model | Group | Rows with parse failure | Total rows | Share |
| --- | --- | ---: | ---: | ---: |
| Fireworks gpt-oss-20b | automationbench-simple-api-offline | 13 | 24 | 54.2% |
| Fireworks gpt-oss-20b | event-categorizer-offline | 7 | 12 | 58.3% |
| Fireworks gpt-oss-20b | synthetic-workflow-shapes-offline | 5 | 9 | 55.6% |
| Anthropic Haiku 4.5 | automationbench-simple-api-offline | 7 | 24 | 29.2% |
| Anthropic Haiku 4.5 | event-categorizer-offline | 2 | 12 | 16.7% |
| Anthropic Haiku 4.5 | synthetic-workflow-shapes-offline | 1 | 9 | 11.1% |

<!-- GENERATED RECEIPTS END -->
