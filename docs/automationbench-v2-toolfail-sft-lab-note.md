# AutomationBench v2 tool-failure SFT lab note

## Frozen lane

All scoring in this note uses the same lane:

- model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- renderer: `nemotron3`
- temperature: `0`
- maximum turns: `14`
- maximum output tokens: `1024`
- runner concurrency: `4`
- split: v2 dev only

The v2 holdout was not read or scored. Its task IDs remain excluded by the
training contamination gate, but the holdout remains sealed and unexecuted.

## Baseline and provenance

The previous 512-token runner default truncated Nemotron while it was still
reasoning, before a complete visible tool object was emitted. This inflated
malformed output and made the old measurements unsuitable as a control. The
committed historical dev artifact also came from a different or unverified
serving lane, so it was discarded as the current control.

The reproducible current base control is
`outputs/base-nemotron3-nano-dev-mt1024.json`:

```text
score 0.7831 | exact-1 0.6389 | zero 0.0833 | steps 6.0278
malformed 0.3889 | forbidden effects 0
```

The data-foundry `toolfail` file never landed. This arm therefore uses a
self-generated, split-safe substitute built from a corrected v2 train-only
probe. The probe covered 120 v2 train tasks, selected 65 failures, and replayed
the fixture oracle policy to produce 65 training conversations and 337
supervised assistant examples.

The contamination gate passed:

```text
selected rows:             65
v2 train rows:             65
dev/holdout rows:           0
unterminated rows dropped:  0
terminal_finish_share:    1.0
stop_token_coverage:      1.0
```

The training arm deliberately used `think_block_policy: empty`. Each target
was rendered with an empty inference-compatible think block:

```text
<think>
</think>
{"tool":"...","arguments":{...}}
```

This was chosen as a stop/length intervention: it suppresses target reasoning
to reduce malformed emissions and completion length. The risk was that it
could remove useful reasoning on long-chain, cross-record, and multi-hop
tasks. The dev measurement below is the result, not an assumption.

## Base versus SFT dev result

The tuned sampler was scored in
`outputs/sft-nemotron3-nano-dev-mt1024.json`. The complete machine-readable
delta is in `outputs/sft-vs-base-dev-band-report.json`.

All deltas are SFT minus base. `forbidden` is the count of forbidden effects,
not a rate.

| Band | Base score | SFT score | Δ score | Δ exact-1 | Δ zero | Δ steps | Δ forbidden | Δ malformed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| aggregation | 0.5000 | 0.5000 | +0.0000 | -0.5000 | -0.5000 | -5.0000 | +0 | -0.5000 |
| cascade | 0.7500 | 0.8750 | +0.1250 | +0.0000 | +0.0000 | -2.5000 | +0 | -1.0000 |
| conditional | 0.8750 | 0.7500 | -0.1250 | +0.0000 | +0.2500 | -2.5000 | +2 | -0.2500 |
| cross-record | 0.9167 | 1.0000 | +0.0833 | +0.1667 | +0.0000 | -2.3333 | +0 | -0.1667 |
| discovery | 0.7500 | 1.0000 | +0.2500 | +0.2500 | -0.2500 | -1.2500 | +0 | +0.0000 |
| long-chain | 0.5476 | 1.0000 | +0.4524 | +1.0000 | +0.0000 | -1.0000 | +0 | -0.5000 |
| multi-hop | 0.7500 | 1.0000 | +0.2500 | +0.5000 | +0.0000 | -4.5000 | +0 | -1.0000 |
| multi-write | 0.7500 | 1.0000 | +0.2500 | +0.2500 | -0.2500 | -1.7500 | +0 | -0.2500 |
| single-write | 1.0000 | 1.0000 | +0.0000 | +0.0000 | +0.0000 | -1.0000 | +0 | +0.0000 |

Overall:

```text
score:          0.7831 -> 0.9306  (+0.1475)
exact-1:        0.6389 -> 0.8611  (+0.2222)
zero:           0.0833 -> 0.0278  (-0.0556)
mean steps:     6.0278 -> 3.7500  (-2.2778)
malformed:      0.3889 -> 0.0000  (-0.3889)
forbidden:      0 -> 2  (+2)
```

The headline stop/length effect is the complete elimination of malformed
outputs and a reduction of 2.28 mean steps. On the reasoning-heavy bands,
long-chain, cross-record, and multi-hop improved rather than regressed in this
dev sample.

Read the per-band rows with care. Dev is 36 tasks, so each band carries only
2 to 6 tasks and a single task moves a band figure by 0.17 to 0.50. The band
columns show direction, not effect size, and no band result here is
individually significant.

### Forbidden-write regression

The one unambiguous regression is safety-shaped and is not visible in the
score column. Base produced zero forbidden effects; SFT produced two, both on
the single task `hard-api-conditional-route-07`, which scored 0 as a result.
Forbidden writes zero the whole task by design, so this is the failure mode
that matters most in this benchmark, and shortening episodes is a plausible
mechanism for it: a model trained to stop sooner has less opportunity to
verify a conditional branch before writing.

One task out of 36 is far too small to characterize, but it should be treated
as a live hypothesis rather than noise, and it is the first thing a follow-up
arm should probe.

### Overfitting caveat

Epoch 2 mean loss is `0.0069`, roughly thirty times lower than epoch 1 on a
65-episode corpus. That is consistent with memorization of the oracle
trajectories. The dev gain is measured on held-out tasks and is therefore
real, but the run is not evidence that two epochs is the right stopping point.

## Training receipt

The real LoRA run wrote `outputs/sft-toolfail-run-receipt.json`:

```text
rows:                 65
examples:            337
epochs:                2
lora rank:            32
learning rate:       1e-4
context length:   16384
think policy:       empty
estimated train: $0.40361376
wall time:         296.22 s
provider called:       true
```

Per-epoch mean loss:

```text
epoch 1: 0.2016924594
epoch 2: 0.0068635605
```

Sampler/checkpoint path:

```text
tinker://1f6831a4-bc00-57bf-a2ac-db14102e7863:train:0/sampler_weights/toolfail-1785647235
```

## Spend and cleanup

Measured or token-accounted spend so far:

```text
base dev sampling:       $0.265195
train probe sampling:    $0.941200
LoRA training:            $0.403614
SFT dev sampling:         $0.046706
total:                    $1.656715
```

The tuned sampler was served only for the dev scoring run. After scoring, the
shim was terminated and no local serving process remains. No additional paid
deployment resource was created by this harness, so there was no persistent
deployment to release.

## Limits of this result

- Dev only, 36 tasks. The holdout was neither read nor scored, so nothing here
  is a sealed-holdout claim.
- The training corpus is self-generated. The upstream tool-failure set never
  landed, so this arm demonstrates that the lane works end to end; it is not a
  measurement of that upstream set.
- Training targets are oracle trajectories for tasks the base model failed, so
  the arm imitates a known-good policy on the exact failure distribution. Gains
  should be expected to shrink on tasks drawn outside it.
- Base and SFT were each run once at temperature 0. There is no seed variance
  estimate.
