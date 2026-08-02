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

The executor work here is contract and test work only: zero provider calls and
zero provider spend. We did not duplicate the Modal executor-contract work,
and we did not create a controller, poller, inbox, decision database, or other
durable controller machinery. This arm neither touches nor depends on the
legacy Spark `buzz-experiment-controller.timer`; systemd timers are outside
the experiment boundary and are left alone.

The reference Workflow executor union is
`'modal' | 'wafer' | 'fireworks' | 'spark'`; it does not include `tinker`.
The required `'tinker'` executor-union amendment is explicitly recorded in
the manifest. Tinker calls used here are blocking and expose no asynchronous
provider job handle, so the executor returns synchronous terminal receipts
and never fabricates an async job.

### Canonical submit contract

Phase E originally pinned the canonical Workflow 4.6.0 contracts from
`/home/ubuntu/up-spec`, branch `yolo/vercel-experiment-orchestrator`, commit
`16b69a3e89882cb2bc6bd9c3f7b5d1e2b0320863`; the current provenance pin is
`c299ca4` (controller review surface PR #545). The
candidate-method payload is
`artifacts/executor-submit.json` and has schema version
`understudy.executor-submit.v1`. Its mapping is:

- `experiment_id`, `candidate.candidate_id`, and `attempt` identify the
  selected `student-sft-epoch1` arm and match the local step ledger.
- `candidate.model` is `Qwen/Qwen3.5-9B`; `model_revision` is the selected
  epoch-1 sampler checkpoint.
- `candidate.policy_ref` and `policy_sha256` point to the immutable policy
  artifact containing only the serving contract and SFT recipe. Prompt text
  is not inlined.
- `workload.dataset_manifest_sha256` is the frozen fixture hash; the verifier
  environment is the offline AutomationBench evaluator and
  `verifier_revision` is the real base-branch revision
  `dd7a9d71f38b40ffbecbbe4a711dd37bfa44d6ce` of
  `src/automationbench-offline.ts`.
- `splits` contain train and dev manifest references and hashes only.
- `limits` record the bounded `390` rollout envelope, concurrency `8`, runtime
  ceiling, and the declared `$100` budget ceiling.

The serialized submit payload contains neither the frozen holdout hash nor the
substring `holdout`; this is asserted by
`artifacts/contract-tests.json`. Holdout is structurally absent from the
submit schema and no sealed-holdout reference is permitted to leak into this
candidate payload.

The real candidate executor is `tinker`, and canonical validation therefore
fails exactly at the executor enum. An offline conformance probe substitutes
`fixture`, which is truthful only for the provider-free verifier lane and
validates every other payload field. The blocking amendment is explicit:
**add `'tinker'` to the executor union in
`experiment-executor-submit-request.json`,
`experiment-executor-job-ref.json`, and
`experiment-executor-cancellation-receipt.json`.** It must not be papered over
by labeling a Tinker candidate as `fixture`.

`executor_tinker.py` emits canonical job references, job status, cancellation
receipts, and usage receipts. Cancellation records
`disposition: already_terminal` for synchronous Tinker calls. Usage
`evidence_scope` is `unknown` for the empty billing response and
`account_window` when billing data is present; all dollar fields remain null
because no dollar amounts are returned.

### Terminal result contract

Phase F re-pinned the vendored contracts to controller commit
`8c8fb65ed5b796b0eb6dfa4bb587484dd509a7f8`; Phase G re-pinned provenance to
current head `c299ca4`. Every vendored schema is byte-identical between the
Phase F and Phase G pins. The submit schema is byte-identical all the way back
to the Phase E pin at `16b69a3e89882cb2bc6bd9c3f7b5d1e2b0320863`, so the
`understudy.executor-submit.v1` field mapping and the Tinker enum blocker are
unchanged. The newer pin adds the expanded
`understudy.experiment-result.v1` and
`understudy.experiment-run-status-response.json` contracts.

`scripts/build_experiment_result.py` emits
`artifacts/experiment-result.json`. Unlike the submit payload, this terminal
result binds train, dev, and holdout refs and hashes, including the frozen
holdout hash. Contract tests assert both deliberate directions:

- submit payload: holdout hash and the substring `holdout` are absent;
- terminal result: the holdout hash is present and bound.

The result compares the untuned `student-base` baseline with selected SFT
epoch 1 using the sealed holdout's verifier-checked reward, per-band reward,
warm-start latency, token, turn, and parse-error measurements. `holdout_clean`
is `true` under the platform semantic reading used here: the single authorized
holdout execution occurred after the committed tolerance predeclaration and
there was no prior access.

`quality_evidence.status` is `measured`, not `calibrated`: the measurements
are real and verifier-checked, but the fixture is saturated, with teacher,
untuned base, and selected SFT all at mean reward `1.000`, so the comparison
has no discriminating power. `request_isolation_proven` is `false` because
Tinker's billing endpoint returned empty account-window data; token counts are
real evaluator measurements, but billing isolation for this run cannot be
proved.

The result records the only genuine holdout failure cluster: two
student-base parse/protocol failures, which SFT eliminated. Its cancellation
receipt is the E3 synchronous `already_terminal` conformance receipt; it uses
the truthful `fixture` executor label because the canonical embedded
cancellation schema still excludes `tinker`, and is not a label for the
Tinker candidate.

The claim boundary is intentionally narrow: quality parity is within the
predeclared tolerance on a saturated 12-task holdout; warm-start latency and
token wins are measured; there is no cost claim because dollar evidence is
absent and the teacher is an approximately 3B-active 30B-A3B MoE versus a
dense 9B student; there is no upstream AutomationBench claim; and each split
has n=12.

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

The sealed holdout was executed exactly once in Phase D, before the later
directive not to run or enable holdout arrived. That execution was authorized
by the original task brief, occurred after the tolerance predeclaration was
committed, and was guarded by the single-use holdout lock. No further holdout
access is possible: the lock remains present and `evaluate.py` refuses
`--split holdout`. The lock and all holdout artifacts are preserved unchanged.

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
