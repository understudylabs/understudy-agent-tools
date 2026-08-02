# Event meeting orchestrator offline fixture

This workload-scoped fixture is synthetic and offline. It contains eight
families with twelve varied instances each:

```text
train: 48
dev: 16
holdout: 32
total: 96
```

Pin:

```text
benchmark_id: meeting-orchestrator-shapes-offline
subset: meeting-orchestrator/api
fixture_id: meeting-orchestrator-shapes-offline-v1
split_seed: 7
```

Frozen hashes:

```text
fixture: a33a00404a9d271662228ab330c116b3cc1722d13d3cb67df58a979da6f12e61
train:   edfa0f4ec6419df5ca836da0601dc10ef43b732383064f0893e84619619676ff
dev:     10b1b065d0aa86d87c2ff21150ebfc560a9eeb5fa662f5a10c0c6f3b9a170c21
holdout: b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae
```

Band counts:

```text
single-write: 12
discovery:    12
conditional:  24
multi-write:  24
no-op-guard:  12
long-chain:  12
```

The environment uses terminal-only partial credit, excludes assertions already
true at reset, gives an empty remaining-assertion set a terminal score of one,
rejects forbidden writes, pins reset seed 7, and refuses holdout access unless
the exact frozen holdout hash is supplied. The no-op guard remains
discriminative because any attempted calendar write is forbidden.

Reasoning-model scoring uses the same completion cap for the runner and local
shim. Use `--max-tokens 2048` with the shim's `--max-tokens 2048` when measuring
the Nemotron reasoning base or any tuned descendant; a lower cap can truncate
the reasoning block before the JSON action and inflate malformed counts. The
workload runner caps concurrency at four and aborts/retries stalled local
requests after 180 seconds.

## Resumable DPO arm

The train sampler supports `--offset` after stride selection,
`--request-timeout-seconds` (default `180`), repeated `--base-url` flags, and
the merge utility. The recorded six-chunk base run used six samples per task,
temperature `0.9`, a 2048-token cap, timeout `600`, and concurrency `2` per
shim across ports 8099 and 8100:

```text
chunks:       6 × 8 tasks
rollouts:     288
sampling wall clock: 11164 seconds across chunks (see chunk artifacts)
merged mean score: 0.2482638888888889
```

Pair mining found 16 tasks with an exact-1 rollout and 29 with a qualifying
near-miss sibling. It emitted 21 turn-level pairs:

```text
band counts: multi-write 9, no-op-guard 5, long-chain 4, conditional 3
tier counts: exact 18, graded 3
```

The graded tier is used only when a band has no exact pair and requires a
strictly higher-scoring, zero-forbidden-effects chosen rollout, a lower-scoring
sibling, and an outcome-changing effective action divergence. Discovery and
single-write had no strict pair under this run. The validator accepted all 21
normalized pairs; no holdout task was read or executed.

The tuned checkpoint was trained with DPO beta `0.1`, three epochs, and LoRA
rank `32` through the unchanged Tinker trainer. Candidate scoring remains
fixture-local and does not imply a promotion decision; the recorded DEV mean
was `0.1875` versus the base `0.40625` on this small graded-data arm.

## Candidate payload contract

`emit-candidate-payload.mjs` emits an immutable
`understudy.executor-submit.v1` payload plus a receipt. The vendored schema is
`experiment-executor-submit-request.json`; its `$comment` records the upstream
path and platform-spec commit `585d8e1`. The payload contains only train and
dev manifest references. The deterministic receipt key is derived from
`experiment_id`, `candidate_id`, and `attempt`. The policy hash covers
hyperparameters, the normalized-pairs hash, and the train receipt hash, never
weights or raw pairs. The script makes no provider calls and adds no
controller, queue, poller, or state database.

The holdout remains sealed. The exact future-only invocation is:

```bash
node scripts/wl-on-event-meeting-orchestrator/zeroshot.mjs --model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --split holdout --frozen-holdout b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae --max-tokens 2048 --base-url http://127.0.0.1:8099/v1
```
