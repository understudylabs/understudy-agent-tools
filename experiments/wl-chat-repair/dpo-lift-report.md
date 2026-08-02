# WL-chat DPO lift report

## Run configuration

- Fixture: `grounded-chat-offline-v1`
- Rubric version: `1.1`
- Train/dev/holdout: 60 / 20 / 20
- Base model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3`
- DPO: LoRA rank 32, beta 0.1, learning rate `1e-5`, 3 epochs
- Holdout hash: `b1a7f5a49f7d90a0cca13a4ec5357fc1cc3eed839299453317ad192663a02850`
- v1.1 rubric-validity fix: stored train/dev/holdout answers were rescored offline on the corrected rubric before pair mining and dev/holdout comparison; the holdout was not resampled.

## Rubric-validity correction and pair mining

The v1.1 correction changed lookup required facts from label-echo phrases to
role tokens, broadened valid unanswerable absence language, and accepted
materially correct synthesis/aggregation phrasing including spelled-out counts
and Unicode date punctuation. The original stored train/dev/holdout answers
were rescored offline; they were not resampled.

The base train rollout used 4 samples per task at temperature 0.8 after the
6-sample attempt was reduced for throughput. Under v1.1 it produced 240
episodes with mean score `0.8660` and one fabrication episode.

| Mining statistic | Value |
| --- | ---: |
| Train tasks with at least one passing sample | 53 |
| Train tasks with at least one failing sample | 23 |
| Tasks with an outcome-changing pair | 16 |
| Tasks skipped because no passing sample existed | 7 |
| Tasks skipped because no failing sample existed | 37 |
| Pair count | 16 |
| Missing-fact pairs | 15 |
| Fabrication pairs | 1 |
| Over-budget pairs | 0 |

All 16 pairs were accepted by the fixture-aware validator:

- raw pair bytes SHA-256:
  `d3b4c96c1ccea58e5c062525b653b8b2e634854370ba47420c9fac0d319ac4ad`
- normalized training bytes SHA-256:
  `19a13f7397e06547e0b2157354e60b78c1940b73e425a7e492cfc9d046fb7c16`
- validation verdict: `pass`
- train-only task IDs: confirmed
- dev/holdout leakage: none

## Training receipt

- Steps: 6
- Final DPO loss: `0.691975`
- Final preference accuracy: `0.625`
- Final margin: `0.002608`
- Checkpoint:
  `tinker://ada9ae20-0265-5e53-88a4-d2193a07b108:train:0/sampler_weights/final`
- Wall clock: 104.3 seconds

## Dev comparison

Temperature was 0 with one sample per task.

| Band | Base mean | DPO mean | Delta | Base pass | DPO pass | Base fabrication | DPO fabrication | Base over-budget | DPO over-budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lookup | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| synthesis | 0.733 | 0.800 | +0.067 | 3/5 | 3/5 | 0 | 0 | 0 | 0 |
| aggregation | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| unanswerable | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| **overall** | **0.933** | **0.950** | **+0.017** | **18/20** | **18/20** | **0** | **0** | **0** | **0** |

## Holdout comparison

The sealed holdout was evaluated once per arm, after the dev comparison.
Temperature was 0 with one sample per task.

| Band | Base mean | DPO mean | Delta | Base pass | DPO pass | Base fabrication | DPO fabrication | Base over-budget | DPO over-budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lookup | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| synthesis | 0.600 | 0.733 | +0.133 | 2/5 | 3/5 | 0 | 0 | 0 | 0 |
| aggregation | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| unanswerable | 1.000 | 1.000 | +0.000 | 5/5 | 5/5 | 0 | 0 | 0 | 0 |
| **overall** | **0.900** | **0.933** | **+0.033** | **17/20** | **18/20** | **0** | **0** | **0** | **0** |

## Interpretation

Under the corrected rubric, DPO improved synthesis mean score by `+0.067` on
dev and `+0.133` on holdout, with overall gains of `+0.017` and `+0.033`
respectively. Lookup, aggregation, and unanswerable bands were already
saturated after the rubric correction. Fabrication and over-budget counts did
not regress. The pair pool broadened to synthesis, aggregation, and
unanswerable examples, but remained small at 16 pairs; the base holdout
answers were rescored offline rather than resampled.
