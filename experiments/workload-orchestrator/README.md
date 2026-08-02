# WL-OR — the "orchestrator" workload repair arm

One workload, end to end: validate the benchmark, find the repair target from
telemetry aggregates, and try to close the gap with DPO on an open-weight base.

| Deliverable | Where |
| --- | --- |
| gate validation of the synthetic slice | [`benchmark-validation.md`](benchmark-validation.md) |
| repair-target memo (aggregates only) | [`repair-memo.md`](repair-memo.md) |
| base vs DPO lift table, per band | [`dpo-lift.md`](dpo-lift.md) |

Everything scored here runs against a **sanitized synthetic fixture slice**.
Telemetry is used for aggregates only — counts, tokens, USD, distributions —
and no raw rows, prompts, completions, or identifiers are committed.

## Contract shape (unified Workflow)

This arm ships a **verifier/contract plus a candidate-method**, not a
controller. There is no poller, queue, or state database here: every module is
a pure function over pinned inputs that writes one artifact.

**Immutable artifact contract — the slice.** `slice.mjs` pins
`wl-or-orchestrator-v1` over the published fixture: family list, inherited
splits, and the three split SHA256s. The holdout is sealed — the pool throws
without the frozen fixture hash — so holdout isolation is enforced by the
contract itself rather than by run discipline.

**Idempotent steps.** Each is deterministic given its key; re-running with the
same key rewrites byte-identical output and never repeats paid work.

| Step | Idempotency key | Returns |
| --- | --- | --- |
| `slice-gates.mjs` | (`slice_id`, `slice_sha256`) | gate report + hashes |
| `slice-rollout.mjs` | (`slice_id`, `split_sha256`, `model`, `temperature`, `samples`, attempt) | scored rows + per-band means |
| `mine-pairs.mjs` | (rollout artifact sha256, `max_per_task`) | `pairs.jsonl` + manifest carrying `pairs_sha256` |
| `pairs-validate.mjs` | (`pairs_sha256`, `train_split_sha256`) | pass/fail verdict + normalized pairs |
| `scripts/tinker-dpo-train.py` | (`pairs_sha256`, base model, hyperparameters) | checkpoint ref + run receipt |

The only paid step is the last one. It takes the validated pairs by hash,
submits one Tinker run, and returns a `tinker://` checkpoint reference in its
receipt; scoring the tuned policy re-serves that reference through the same
shim the base was scored on. Retrying the step with the same
(`pairs_sha256`, base model, hyperparameters) key must resolve to the existing
receipt rather than opening a second paid run.

**What crosses the boundary.** Artifact paths, SHA256 hashes, scores, counts,
and the checkpoint reference. Never weights, credentials, raw traces, prompts,
or labels.

### Mapping to `understudy.executor-submit.v1`

This arm is a **candidate-method**, so what it hands the controller is a submit
payload, not an executor implementation.
[`submit-payload.mjs`](submit-payload.mjs) emits it and
[`tests/workload-orchestrator-submit.test.mjs`](../../tests/workload-orchestrator-submit.test.mjs)
asserts the contract with no provider calls;
[`artifacts/executor-submit.json`](artifacts/executor-submit.json) is the
committed instance.

| Contract field | This arm |
| --- | --- |
| `candidate.candidate_id` | `wl-or-dpo-b0.1-e3-r32` |
| `candidate.executor` | `fixture` — scoring is the offline verifier; Tinker is not in the enum, and the trained policy travels by reference |
| `candidate.model` / `model_revision` | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` / `BF16` |
| `candidate.policy_ref` / `policy_sha256` | the run receipt path, and the sha256 of the **policy descriptor** (method, base, checkpoint ref, hyperparameters, pairs hash) — the checkpoint URI is hashed in, never inlined |
| `workload.id` | `wl-or-orchestrator-v1` |
| `workload.dataset_manifest_ref` / `_sha256` | the gate report, and the slice sha256 |
| `workload.verifier_environment` / `verifier_revision` | the offline outcome-first benchmark, pinned at the train split sha256 |
| `splits.train_manifest_ref` / `dev_manifest_ref` | `slice.mjs#train@<sha>` / `#dev@<sha>` |
| `limits` | budget, candidate/request concurrency, rollout cap, runtime cap |
| holdout | **structurally absent** — asserted by test; the sealed split is read only by the scorer, with the frozen fixture hash, after dev has settled |

## Run it

```sh
npm run build

# 1. contract — gates on the slice (offline, no model calls)
node experiments/workload-orchestrator/slice-gates.mjs \
  --out experiments/workload-orchestrator/artifacts/slice-gates.json
node --test tests/workload-orchestrator-slice.test.mjs

# 2. base — serve the base through the Tinker shim, score dev
TINKER_API_KEY=… python scripts/tinker-openai-shim.py \
  --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 --port 8099 &
node experiments/workload-orchestrator/slice-rollout.mjs --model nemotron-3-nano-base \
  --split dev --out experiments/workload-orchestrator/artifacts/base-dev.json

# 3. mine — sample the TRAIN split, then turn siblings into preference pairs
node experiments/workload-orchestrator/slice-rollout.mjs --model nemotron-3-nano-base \
  --split train --samples 6 --temperature 0.8 --transcripts \
  --out experiments/workload-orchestrator/artifacts/base-train-rollouts.json
node experiments/workload-orchestrator/mine-pairs.mjs \
  --rollouts experiments/workload-orchestrator/artifacts/base-train-rollouts.json \
  --pairs experiments/workload-orchestrator/artifacts/dpo-pairs.jsonl \
  --manifest experiments/workload-orchestrator/artifacts/dpo-pairs.manifest.json
node experiments/workload-orchestrator/pairs-validate.mjs \
  --pairs experiments/workload-orchestrator/artifacts/dpo-pairs.jsonl \
  --manifest experiments/workload-orchestrator/artifacts/dpo-pairs.manifest.json \
  --out <normalized.jsonl> \
  --report experiments/workload-orchestrator/artifacts/dpo-pairs.validation.json

# 4. train + score — see docs/synthetic-offline-dpo-nemotron.md for the lane
```

The holdout is read once per arm, with the frozen hash, after dev has settled.
