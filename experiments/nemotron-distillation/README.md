# Nemotron-to-Qwen distillation (P3) — lab note

This arm distills the retained Nemotron-3-Nano-30B-A3B GRPO multi-write
teacher adapter from PR #402/#408 into a smaller Qwen3.5-9B dense student.
The student uses LoRA rank 32 and SFT on 66 verifier-accepted teacher
trajectories. The teacher produced 240 candidates (five per each of 48 train
tasks), with a 27.5% acceptance rate and no task coverage gaps.

The frozen benchmark is `automationbench-simple-api-offline`, fixture
`automationbench-simple-api-offline-v1`, seed 7, with 48 train, 12 dev, and
12 holdout tasks. Each split has four tasks in each of `single-write`,
`discovery`, and `multi-write`. The evaluator is the sole authority for
state, reward, split membership, and holdout authorization.

## Runtime dependency

The Node AutomationBench service must be run from:

```text
/home/ubuntu/wt-402
```

This worktree supplies the `nemotron-v1` prompt variant, parser, oracle
endpoints, and `replayOracleTrajectory`. PR #402 was not merged into the
service branch. A future reproduction must provision the same runtime
worktree, build its `dist`, and pass its path explicitly with
`--service-repo`; this experiment does not import service code across
branches.

The repository-check baseline for this lab note is
`devin/178561-cookbook-audit-and-benchmark-repair`, not `origin/main`; that
branch also passed the checks.

All Python commands use isolated runtime glue:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook ...
```

## What the arm did

- Teacher: Nemotron-3-Nano-30B-A3B GRPO multi-write adapter retained from
  PR #402/#408.
- Student: Qwen3.5-9B dense base with LoRA rank 32.
- Distillation data: 240 on-policy teacher candidates over train only;
  66 terminal-reward-1.0 trajectories retained; no zero-coverage tasks.
- SFT: four epochs, batch size 4, learning rate `1e-4`, max length 4096,
  trained on all assistant messages.
- Evaluation: greedy temperature `0.0`, with all quality claims made against
  the offline verifier.
- GRPO polish: not run; the predeclared decision was that dev provides no
  quality gap to close.

## Headline finding

Dev is saturated on this fixture. The teacher, untuned student base, and all
four SFT epochs scored mean reward `1.000` overall and `1.000` in every band.
There is no quality lift to claim from distillation here.

What SFT actually bought was protocol conformance and efficiency:

| Metric | Student base | Selected SFT epoch 1 |
|---|---:|---:|
| Mean reward | 1.000 | 1.000 |
| Parse-error rate | 16.7% | 0% |
| Mean prompt+sampled tokens/task | 2,275 | 1,405 |
| Mean model turns | 4.42 | 3.33 |

The selected candidate was SFT epoch 1 by mean dev reward, with the
predeclared earliest-epoch tie-break.

## Sealed holdout

The predeclaration in `artifacts/holdout-tolerance.json` was read without
editing. Its SHA-256 recorded in the single-use lock is:

```text
f2b2037c37c83c7f515251c8c52bf6f831b3df8a8927a33fed24c9064ee4cb2e
```

The exact paired model set was `teacher`, `student-base`, and `student-sft`,
using the frozen holdout hash
`a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`.
Each model received one discarded warm-up rollout followed by the same
12-task greedy pass.

| Model | Mean reward | Single-write | Discovery | Multi-write | Mean task latency | Mean turn latency | P50 turn | P90 turn | Mean turns | Tokens/task | Parse errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Teacher | 1.000 | 1.000 | 1.000 | 1.000 | 7.021 s | 2.106 s | 1.670 s | 4.304 s | 3.33 | 1,444 | 0% |
| Student base | 1.000 | 1.000 | 1.000 | 1.000 | 5.677 s | 1.239 s | 1.269 s | 1.676 s | 4.58 | 2,371 | 16.7% |
| Student SFT epoch 1 | 1.000 | 1.000 | 1.000 | 1.000 | 4.147 s | 1.244 s | 1.078 s | 1.670 s | 3.33 | 1,401 | 0% |

The predeclared verdict was **PASS**. Exact checks:

| Condition | Observed | Limit | Result |
|---|---:|---:|---|
| Overall teacher-to-student mean reward deficit | 0.000 | 0.084 | PASS |
| Single-write deficit | 0.000 | 0.25 | PASS |
| Discovery deficit | 0.000 | 0.25 | PASS |
| Multi-write deficit (primary band) | 0.000 | 0.25 | PASS |
| Student hard fails over teacher | 0 | 1 | PASS |
| Student parse-error rate | 0.000 | 0.1 | PASS |

The combined artifact is `artifacts/sealed-holdout.json`. The single-use
`artifacts/holdout-lock.json` records the declared model set, frozen hash, and
tolerance-file hash. A second invocation was attempted after the run and was
refused before provider initialization:

```text
holdout is single-use and already locked: artifacts/holdout-lock.json
```

## Warm-start latency methodology

The published latency values are the warm-start measurements, not the
original cold-start measurements. Each model used one client-creation
measurement, one discarded full warm-up rollout, and three timed dev passes
over all 12 tasks.

| Model | Client creation | Warm-up | Mean/turn | P50/turn | P90/turn | Mean task | Across-pass task variance |
|---|---:|---:|---:|---:|---:|---:|---:|
| Teacher | 0.630 s | 5.301 s | 2.242 s | 2.093 s | 3.252 s | 7.535 s | 0.1872 |
| Student base | 0.543 s | 4.973 s | 1.206 s | 1.260 s | 1.659 s | 5.324 s | 0.0032 |
| Student SFT epoch 1 | 0.592 s | 8.869 s | 1.631 s | 1.470 s | 2.735 s | 5.435 s | 0.7189 |

A naive first measurement made the adapter look approximately 2.6x slower
than its own base. The warm-start measurement reduced SFT from 10.360 s/task
to 5.435 s/task, close to the base's 5.324 s/task. The original gap was a
client warm-up/adapter-attach artifact, not steady-state serving cost. This
is a reusable methodological warning: never publish a first-request latency
comparison for adapters without a discarded warm-up and repeated timed passes.

The teacher is 30B total / approximately 3B active parameters as a MoE,
whereas the student is a dense 9B. A latency win therefore does not establish
a per-token cost win. `cost.usd` remains null because the provider billing
endpoint returned no dollar amounts.

## Workflow 4.6.0 contract mapping

This directory is a thin contract layer over the existing phase scripts, not
a second durable controller:

- Candidate-method: teacher rollout generation, SFT, and evaluation.
- Verifier/contract pieces: entry gate and the single-use sealed holdout with
  its predeclared tolerance.
- `artifacts/artifact-manifest.json`: immutable artifact refs, hashes, sizes,
  producing steps, phase, frozen hashes, verifier identity, and serving
  contracts.
- `artifacts/step-ledger.json`: local file-keyed idempotency ledger.
- Each phase accepts `--experiment-id`, `--candidate-id`, and `--attempt`.
- `artifacts/events.jsonl`: small redacted `run`, `candidate`, `rollout`,
  `score`, `usage`, and `error` event schema with no raw prompts or traces.

The reference Workflow executor union is
`'modal' | 'wafer' | 'fireworks' | 'spark'`; it does not include `tinker`.
The required `'tinker'` executor-union amendment is explicitly recorded in
the manifest. Tinker calls used here are blocking and expose no asynchronous
provider job handle, so the executor returns synchronous terminal receipts
and never fabricates an async job.

## Receipts, usage, and cleanup

Receipt artifacts exist for:

- teacher trajectory generation,
- SFT training,
- three warm-start dev evaluations,
- the three paired holdout model evaluations.

The provider usage endpoint returned empty `data` and `sessions` with an empty
delta for every receipt. Measured local workload totals remain recorded in the
artifacts: 240 teacher candidates / 66 retained trajectories, 68 SFT steps,
and 111 warm-start dev rollouts. The sealed pass added three warm-ups plus 36
timed holdout rollouts. No dollar spend can be inferred from these receipts;
all provider-backed artifacts retain `cost.usd: null`.

No always-on resource or service process remains running. No holdout run,
GRPO run, or additional provider job was started after the paired pass.

## What would actually move this

This fixture cannot discriminate these models: 12 dev and 12 holdout tasks,
with only four tasks per band, make one task approximately `0.083` mean
reward. The next arm needs a harder fixture or a band with real headroom.
That is the honest next step rather than dressing up a saturated benchmark.

## Commands

Build and verify the manifest:

```text
python scripts/build_manifest.py
python scripts/build_manifest.py --verify
```

Prove verdict failure paths without provider calls:

```text
PYTHONPATH=scripts uv run --no-project --python 3.12 \
  --with tinker --with tinker-cookbook \
  python scripts/holdout_verdict_smoke.py
```

The sealed runner is intentionally single-use:

```text
uv run --no-project --python 3.12 --with tinker --with tinker-cookbook \
  python scripts/sealed_holdout.py \
  --models teacher student-base student-sft \
  --tolerance-file artifacts/holdout-tolerance.json \
  --service-repo /home/ubuntu/wt-402
```
