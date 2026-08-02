# Multi-base bake-off — procedure

Which open-weight base should we standardise on, per workload? This directory
runs the identical ladder — **base → SFT → GRPO** — on three candidate bases
under **one verifier, one serving contract, one fixture**, and ranks them by
quality together with the serving cost and latency measured in the same runs.

Results and the ranked table: [`RESULTS.md`](RESULTS.md).

Candidates:

| Base | Params | Ladder renderer |
| --- | --- | --- |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` | 30B A3B MoE | `nemotron3` (thinking; the disabled renderer over-acts, see RESULTS) |
| `Qwen/Qwen3.6-27B` | 27B | `qwen3_5_disable_thinking` |
| `Qwen/Qwen3.5-9B` | 9B | `qwen3_5_disable_thinking` |

## What makes it a controlled comparison

Everything a base could otherwise be advantaged by is pinned in
[`contract.mjs`](contract.mjs) and hashed into every artifact as
`contract_sha256`:

- **Verifier** — `src/automationbench-offline.ts`, terminal `partialCredit`.
  Nothing else scores anything, at any rung. The GRPO reward *is* the eval
  metric, computed by the same code path.
- **Serving contract** — one system prompt, one protocol (one JSON tool call
  per turn), `temperature=0`, `max_tokens=2000`, 14-turn cap, 3 consecutive
  malformed replies ends the episode, 4000-character observation budget, and
  one strict parser. Malformed output is rejected, never repaired.
- **Fixture** — `automationbench-simple-api-offline-v2`, 216 synthetic tasks
  (train 120 / dev 36 / **sealed holdout 60**), seed 7. Synthetic and
  index-generated: no customer or tenant data leaves the box.
- **Renderer** — both thinking modes are measured on dev for every base and the
  better one carries that base into the ladder. Thinking flips sign per base
  (it is worth +0.51 to Nemotron and −0.34 to Qwen3.5-9B), so pinning one mode
  across bases would handicap whichever base disagrees. The renderer is part of
  the hashed candidate policy, and the token and latency cost of thinking is
  paid in the same cost column everyone else is ranked on.

`rank.mjs` refuses to rank artifacts whose `contract_sha256` or
`fixture_sha256` differ, so an accidental drift shows up as a failed report
rather than a quietly invalid table.

## Split discipline

- **train (120)** — SFT trajectories and GRPO rollouts. `env-service.mjs` is
  started for the train split and refuses every task id outside it, so an RL
  loop physically cannot roll on dev or holdout.
- **dev (36)** — every rung of every base, and the only split used to choose
  anything (renderer, rung, hyperparameters).
- **holdout (60)** — sealed. `taskPool` refuses to return it without the frozen
  hash `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9`. Run
  **once** per final candidate, after selection is closed. **Not executed in
  this run** — the platform directive froze holdout execution, so the ranked
  table is dev-basis and records `holdout_executed: false`. The holdout never
  appears in a submit payload at all; it has no representation in
  `understudy.executor-submit.v1`.

## Running it

Build first (`npm run build`) — the runners import the compiled verifier from
`dist/`.

### 0. Freeze the fixture

```bash
node scripts/automationbench-v2-freeze.mjs
```

### 1. Serve a base or a checkpoint

One shim per (base, renderer); a tuned rung adds `--model-path`:

```bash
TINKER_API_KEY=... TINKER_DISABLE_PYQWEST=1 \
  python scripts/tinker-openai-shim.py \
    --base-model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking --port 8101
```

### 2. Score a rung

```bash
node experiments/multi-base-bakeoff/run-eval.mjs \
  --label qwen3.5-9b/base --rung base --lane tinker \
  --renderer qwen3_5_disable_thinking \
  --base-url http://127.0.0.1:8101/v1 --model Qwen/Qwen3.5-9B \
  --split dev --concurrency 6 \
  --out outputs/bakeoff/qwen3.5-9b-base-dev.json
```

Fireworks serverless is the same command with
`--lane fireworks --base-url https://api.fireworks.ai/inference/v1` and
`FIREWORKS_API_KEY` in the environment. Add
`--price-input-usd-per-mtok/--price-output-usd-per-mtok/--price-source` to have
the evidence row carry a costed `$/1k tasks`.

### 3. SFT rung

```bash
node experiments/multi-base-bakeoff/export-oracle-sft.mjs \
  --out outputs/bakeoff/sft/oracle-train.jsonl

TINKER_API_KEY=... TINKER_DISABLE_PYQWEST=1 \
  python experiments/multi-base-bakeoff/sft-train.py \
    --trajectories outputs/bakeoff/sft/oracle-train.jsonl \
    --base-model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking \
    --out outputs/bakeoff/sft/qwen3.5-9b-receipt.json
```

The exporter replays the fixture's scripted oracle through the real
environment and fails closed unless every replay scores exactly 1.0 with no
write outside `allowedWrites`. Each assistant turn is exported as its own
example with loss on the last message only, because the thinking-disabled
renderers rewrite earlier assistant turns when re-rendering a longer
conversation.

### 4. GRPO rung

```bash
node experiments/multi-base-bakeoff/env-service.mjs --split train --port 8200 &

TINKER_API_KEY=... TINKER_DISABLE_PYQWEST=1 \
  python experiments/multi-base-bakeoff/grpo-train.py \
    --env-url http://127.0.0.1:8200 \
    --base-model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking \
    --init-checkpoint <sft state checkpoint> \
    --out outputs/bakeoff/grpo/qwen3.5-9b-receipt.json
```

Group-relative advantage over `--group-size` episodes of the same task, reward
= terminal `partialCredit`, no shaping, constant-reward groups dropped.

### 5. Sealed holdout, once, then rank

```bash
node experiments/multi-base-bakeoff/run-eval.mjs ... --split holdout \
  --frozen-holdout 2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9 \
  --out outputs/bakeoff/holdout/<label>.json

node experiments/multi-base-bakeoff/rank.mjs outputs/bakeoff/**/*.json \
  --out outputs/bakeoff/ranked.json --markdown outputs/bakeoff/ranked.md
```

## How this maps to the unified Workflow

This directory is a **candidate-method + verifier/contract** surface and a
**UI-artifact** (the ranked table). It is deliberately not a controller: there
is no poller, no queue, no state database, and no process that must stay up for
a result to be true. Every script is a one-shot CLI that reads immutable inputs
and writes an immutable artifact.

**Candidate payload.** [`submit-payload.mjs`](submit-payload.mjs) emits a
candidate as [`understudy.executor-submit.v1`](contracts/experiment-executor-submit-request.json)
(vendored from the internal orchestrator branch, byte-identical at its
authoritative head `c299ca4`), validated in
`tests/multi-base-bakeoff-submit.test.mjs` with no provider calls:

| Schema field | Bake-off value |
| --- | --- |
| `candidate.policy_sha256` | sha256 of base model + renderer + rung + hyperparameters + checkpoint ref + the whole serving contract (system prompt, params, parser) |
| `candidate.policy_ref` | `understudy://policy/<candidate>@<policy_sha256>` — the policy body never travels |
| `workload.id` / `dataset_manifest_sha256` | fixture id / `fixture_sha256` |
| `workload.verifier_environment` / `verifier_revision` | `understudy.automationbench.offline` / verifier revision |
| `splits.{train,dev}_manifest_sha256` | `split_sha256` for train and dev — **holdout is structurally absent** |
| `limits` | budget, candidate and per-candidate request concurrency, rollout cap, runtime cap |

**Idempotency.** `idempotencyKey(request)` is sha256 over
`(experiment_id, candidate_id, attempt)` and nothing else, so a retried step
rebuilds a byte-different payload and still resolves to the same provider job.
A retry must return the existing job; it must never buy a second one.

**Executor boundary.** The Tinker shim, `env-service.mjs` and the trainers are
executors invoked *by* a step, not runtimes that own state. Long, paid work
(SFT, GRPO) returns a checkpoint reference in a
`understudy.bakeoff.train_receipt.v1` receipt; a cancelled run records the
cancellation in the same receipt shape rather than disappearing. Usage is
reconciled from the receipt and the evidence row's measured token counts
against a price card (`price-card.json`), never hardcoded into a runner.

**What crosses the boundary.** Artifact refs and sha256 hashes only. Prompts,
trajectories, per-task rows, labels, weights and credentials stay on the box;
the redacted summary a Workflow event needs is score, counts, latency, tokens,
ended-reason and hashes.

## Cleanup

Tinker shims and the env service are local processes: `pkill -f
tinker-openai-shim.py` and `pkill -f env-service.mjs` when the run is done.
Tinker training and sampling are billed per use with nothing left running
between calls; no deployment is created and there is nothing to scale to zero.
Any Fireworks deployment created for a lane must be deleted at the end of the
run — serverless inference leaves no resource behind.
