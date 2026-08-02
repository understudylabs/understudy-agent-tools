# `on-event-meeting-orchestrator` DPO lift

## Verdict

On this fixture and at this pair volume, DPO did not earn promotion. The
headline three-epoch arm fell from `0.40625` to `0.1875` mean DEV score. The
bounded sensitivity checks improved on the headline arm but still did not beat
the base: one epoch reached `0.25`, and the 3-epoch learning-rate reduction
to `2.5e-6` reached `0.34375`. These are sensitivity observations, not a
configuration-selection exercise or a promotion recommendation.

## Fixture gates and frozen identity

The freeze gates passed:

```text
oracle_mean: 1.0
sentinel_max: 0.0
lazy_max: 0.0
failures: []
```

Leakage and sanitization tests passed. Reset determinism and immutable fixture
state passed. Holdout reads without the exact frozen hash, or with a wrong
hash, were refused. No holdout task, rollout, score, pair, or training input
was executed.

Frozen hashes:

```text
fixture: a33a00404a9d271662228ab330c116b3cc1722d13d3cb67df58a979da6f12e61
train:   edfa0f4ec6419df5ca836da0601dc10ef43b732383064f0893e84619619676ff
dev:     10b1b065d0aa86d87c2ff21150ebfc560a9eeb5fa662f5a10c0c6f3b9a170c21
holdout: b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae
```

## Regression diagnosis

The base and headline tuned DEV artifacts do not record full trajectories, so
the exact total number of successful write calls cannot be reconstructed from
these rows. The observable proxy is decisive:

| Metric | Base | Headline tuned |
|---|---:|---:|
| Mean score | 0.40625 | 0.1875 |
| Mean steps | 5.00 | 4.00 |
| Finished episodes | 15/16 | 16/16 |
| Budget-ended episodes | 1/16 | 0/16 |
| Malformed episodes | 1/16 | 0/16 |
| Episodes with forbidden writes | 3/16 | 2/16 |

Malformed output disappeared, but that did not translate into better actions.
The policy became shorter and more decisive: every episode ended in `finish`,
the mean trajectory lost one turn, and the score fell. This is an
under-acting / early-finish collapse, not a JSON-discipline problem.

The band deltas reinforce that diagnosis:

```text
conditional:  0.500 -> 0.250  (-0.250)
multi-write:   0.875 -> 0.250  (-0.625)
long-chain:    0.500 -> 0.500  (+0.000)
discovery:     0.000 -> 0.000  (+0.000)
single-write:  0.000 -> 0.000  (+0.000)
no-op-guard:   0.000 -> 0.000  (+0.000)
```

The largest loss was in `multi-write`, which supplied 9 of the 21 pairs.
That is consistent with overfitting to a narrow subset of multi-write
near-miss action patterns, while the zero-pair `discovery` and `single-write`
bands had no preference coverage at all. The result should therefore be read
as a coverage-limited under-acting collapse, not evidence that DPO reliably
improves or harms every family.

## Lift table

All DEV scoring used the same fixture, seed, protocol, 2048-token runner cap,
2048-token shim cap, temperature `0`, and DEV split. The headline arm is shown
first as requested.

### Headline configuration

```text
beta 0.1, epochs 3, LoRA rank 32, learning rate 1e-5
checkpoint: tinker://9c850318-a92f-5f5b-be81-1ef141575811:train:0/sampler_weights/final
```

| Band | Base | Headline tuned | Delta |
|---|---:|---:|---:|
| single-write | 0.000 | 0.000 | +0.000 |
| discovery | 0.000 | 0.000 | +0.000 |
| conditional | 0.500 | 0.250 | -0.250 |
| multi-write | 0.875 | 0.250 | -0.625 |
| no-op-guard | 0.000 | 0.000 | +0.000 |
| long-chain | 0.500 | 0.500 | +0.000 |
| **overall** | **0.40625** | **0.1875** | **-0.21875** |

### Sensitivity checks

These arms were bounded checks only; neither is the deliverable headline.

| Arm | Conditional | Multi-write | Long-chain | Overall | Delta vs base |
|---|---:|---:|---:|---:|---:|
| 1 epoch, beta 0.1, LR 1e-5 | 0.250 | 0.500 | 0.500 | 0.250 | -0.15625 |
| 3 epochs, beta 0.1, LR 2.5e-6 | 0.500 | 0.625 | 0.500 | 0.34375 | -0.0625 |

Discovery, single-write, and no-op-guard were `0.000` for both sensitivity
arms as well. The lower learning rate reduced the regression, but did not
close it.

## Pair yield and coverage

The merged TRAIN run contained 288 rollouts: 48 tasks × 6 samples. Pair
accounting was:

```text
tasks with at least one exact-1 rollout:       16
tasks with a qualifying near-miss sibling:    29
normalized pairs:                             21
exact tier:                                   18
graded tier:                                   3
```

Pair counts:

```text
multi-write:  9
no-op-guard:  5
long-chain:   4
conditional:  3
discovery:    0
single-write: 0
```

The graded tier selected a strictly higher-scoring, zero-forbidden-effects
rollout over a strictly lower-scoring sibling, and still required an
outcome-changing effective action divergence. `discovery` and `single-write`
yielded zero pairs. That is a material coverage gap and limits the experiment's
conclusions about those bands.

The validator accepted all 21 normalized pairs, with no duplicate, unknown,
dev, holdout, private-identifier, or fixture-hash failures.

## Receipts and token-cap correction

Sampling receipts:

```text
base DEV:       16 rollouts, 80 sampling calls, 240 s
TRAIN chunks:   288 rollouts, 1382 recorded action calls, 11164 s aggregate
headline DPO:   21 pairs, 3 epochs, 79.7 s training
1-epoch check:  21 pairs, 1 epoch, 52.5 s training
low-LR check:   21 pairs, 3 epochs, 81.8 s training
```

The merged training artifact is committed without raw trajectories. Each row
retains `trajectory_sha256` computed as
`sha256(JSON.stringify(trajectory))`. Per-chunk files are ignored and removed
from git.

The earlier 512-token baseline was a measurement artifact:

```text
runner/shim cap 512:  mean 0.21875, malformed 0.9375
runner/shim cap 2048: mean 0.40625, malformed 0.0625
```

The same 2048 cap was used for all DPO arms. The renderer strips Nemotron
reasoning blocks before returning assistant content, and the runner defensively
strips them again.

## Holdout and deliverable shape

**Holdout: clean / not executed.** Its pinned hash is
`b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae`.
The exact future-only command is:

```bash
node scripts/wl-on-event-meeting-orchestrator/zeroshot.mjs --model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --split holdout --frozen-holdout b2af83e5743fec33ec3e21cfedac21f2e4b251a898ecc834673fb362189400ae --max-tokens 2048 --base-url http://127.0.0.1:8099/v1
```

This arm is a verifier/contract plus candidate-method. It emits immutable,
hash-stamped artifacts and an `understudy.executor-submit.v1` candidate
payload. The payload structurally omits holdout references and hashes. Its
receipt carries a deterministic idempotency key derived from
`(experiment_id, candidate_id, attempt)`. No controller, poller, queue, or
state database was introduced.

On this fixture, at this pair volume, DPO did not earn promotion.
