# AutomationBench v2 Nemotron SFT → GRPO scale-validation arm

This directory records a train-only-warm-started SFT → GRPO lab run against
the larger synthetic offline AutomationBench v2 fixture. The Node evaluator is
the sole authority for state transitions, terminal reward, split membership,
and holdout authorization. The sealed holdout was evaluated exactly once per
arm and must not be rerun.

## Arm and provenance

- Base model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- LoRA rank: `32`
- RL dataset seed: `7`
- SFT data: 192 oracle trajectories from `train`
- GRPO: 40 steps, group size 8, 8 groups per batch, temperature 1.0,
  `importance_sampling`, learning rate `1e-5`, constant-reward filtering
  enabled
- Evaluation: greedy temperature 0.0, one sample per task
- Fixture: `automationbench-simple-api-offline-v2`
- Counts: train 192, dev 48, holdout 48

The brief mentioned LoRA rank 16, but the winning #402 recipe used rank 32.
This arm reproduces the winning recipe faithfully with rank 32.

Fixture and split provenance:

```text
fixture_sha256: 81c7b17208aaa907d071e64126f6195033df819e724a000b6179f5e77f1cbd5a
train:         8b906b7400ed064b1f88db7239b4eba0f6ab19f8538de52f9498e6a41a4732d2
dev:           931219077e7d6006e14e35a52112cccfdf14ece9046c78b468d013b265e2e173
holdout:       7c15a9e33d687792cf613e9bd53b9d544dbc400dc35b8aeaa4795b16593d84d1
counts:        train 192, dev 48, holdout 48
split_seed:    7
```

`nemotron3_disable_thinking` is deliberate: the action protocol requires one
canonical JSON object per turn. Reasoning traces would make SFT targets
non-canonical and increase token cost. Tool calls are driven through the
sampling/renderer path rather than `tools=`, which is not implemented for
this renderer.

## Fixture gates

Before training, the v2 fixture passed the deterministic offline gates:

- Oracle reward: `1.0` on all 288 tasks
- Sentinel reward: `0.0` on all 288 tasks
- Train oracle export: 192 rows, train split only
- Guard contact: unwritable by every task
- Task uniqueness, reachability, no-free-credit, and no-label-leakage checks:
  passed

## Results

All values are means over the complete split. Strict pass means reward exactly
`1.0`. SFT epoch train evaluations and GRPO non-selected train checkpoints
were not separately rerun; the reproduction harness evaluates every SFT epoch
and GRPO checkpoint on dev, then evaluates the selected checkpoint on train.

### Train and dev

| Arm | Train mean | Train strict | Dev mean | Dev strict |
|---|---:|---:|---:|---:|
| Base | 0.804688 | 0.765625 | 0.798611 | 0.770833 |
| SFT epoch 1 | — | — | 0.986111 | 0.979167 |
| SFT epoch 2 | — | — | 1.000000 | 1.000000 |
| SFT epoch 3 | — | — | 1.000000 | 1.000000 |
| SFT epoch 4 | — | — | 1.000000 | 1.000000 |
| Selected SFT epoch 4 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| GRPO step 10 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |
| GRPO step 20 | — | — | 1.000000 | 1.000000 |
| GRPO step 30 | — | — | 1.000000 | 1.000000 |
| GRPO step 40 | — | — | 1.000000 | 1.000000 |

SFT selection uses highest dev mean with latest-tied-epoch tie-break.
Epochs 2–4 tied, so epoch 4 was selected. GRPO selection uses highest dev
mean with earliest-step tie-break. Steps 10–40 tied, so step 10 was selected.

### Sealed holdout

The sealed holdout contains 48 tasks. Wilson 95% intervals below are for the
strict-pass proportion.

| Arm | Mean | Strict | Wilson 95% CI |
|---|---:|---:|---:|
| Base | 0.8958 | 40/48 = 0.8333 | [0.704, 0.913] |
| SFT epoch 4 | 1.0000 | 48/48 = 1.0000 | [0.926, 1.000] |
| SFT + GRPO step 10 | 1.0000 | 48/48 = 1.0000 | [0.926, 1.000] |

Holdout per-band means:

| Band | n | Base | SFT epoch 4 | SFT + GRPO step 10 |
|---|---:|---:|---:|---:|
| Single-write | 12 | 1.0000 | 1.0000 | 1.0000 |
| Discovery | 15 | 0.9333 | 1.0000 | 1.0000 |
| Multi-write | 21 | 0.8095 | 1.0000 | 1.0000 |

The headline result is that SFT lifts holdout mean by `+0.1042` over base,
while GRPO adds `+0.0000` over SFT at scale. The GRPO marginal lift does not
survive this larger holdout: SFT alone reaches the ceiling across every band.
The prior #402 GRPO-only lift of approximately `+0.056` on `N=12` is
consistent with small-sample noise given these intervals.

The base is not at ceiling (`0.8958` mean, `0.8333` strict), but the tuned
arms are. A genuinely discriminative harder fixture would need tasks that
oracle-SFT cannot trivially imitate. This is a synthetic offline fixture, not
an upstream AutomationBench result.

## Selected checkpoint paths

Selected SFT epoch 4:

```text
tinker://6a954d26-3cd1-5d79-b50b-ace95e187cef:train:0/sampler_weights/sft-epoch4
tinker://6a954d26-3cd1-5d79-b50b-ace95e187cef:train:0/weights/sft-epoch4-state
```

Selected GRPO step 10:

```text
tinker://5eb88b9c-21cc-55c5-b50a-7980daf76e39:train:0/sampler_weights/000010
tinker://5eb88b9c-21cc-55c5-b50a-7980daf76e39:train:0/weights/000010
```

Selection records are in `artifacts/sft-selection.json` and
`artifacts/grpo-selection.json`.

## Reproduction

These commands assume `/home/ubuntu/tinker-venv/bin/python` has `tinker` and
`tinker-cookbook` installed. Provide `TINKER_API_KEY` only through the
environment; never write it to an artifact.

Start the evaluator service:

```bash
node scripts/automationbench-rl-service.mjs
```

Export the train-only oracle data:

```bash
node scripts/automationbench-oracle-trajectories.mjs \
  --out experiments/nemotron-tinker-grpo-scale/artifacts/oracle-train.jsonl
```

Baseline evaluation:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo-scale/evaluate.py \
  --split train --model-path base --label baseline-train \
  --temperature 0.0 --samples 1 \
  --out experiments/nemotron-tinker-grpo-scale/artifacts/baseline-train.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo-scale/evaluate.py \
  --split dev --model-path base --label baseline-dev \
  --temperature 0.0 --samples 1 \
  --out experiments/nemotron-tinker-grpo-scale/artifacts/baseline-dev.jsonl
```

SFT:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo-scale/sft.py
```

GRPO Stage 1 and Stage 2:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo-scale/grpo.py --stage 1 --max-steps 2

/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo-scale/grpo.py --stage 2 --max-steps 40
```

The following are the exact sealed holdout commands used for this arm. They
were run exactly once and must not be rerun:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo-scale/evaluate.py --split holdout --model-path base --label holdout-base --temperature 0.0 --samples 1 --frozen-holdout-sha256 7c15a9e33d687792cf613e9bd53b9d544dbc400dc35b8aeaa4795b16593d84d1 --out experiments/nemotron-tinker-grpo-scale/artifacts/holdout-base.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo-scale/evaluate.py --split holdout --model-path tinker://6a954d26-3cd1-5d79-b50b-ace95e187cef:train:0/sampler_weights/sft-epoch4 --label holdout-sft-epoch4 --temperature 0.0 --samples 1 --frozen-holdout-sha256 7c15a9e33d687792cf613e9bd53b9d544dbc400dc35b8aeaa4795b16593d84d1 --out experiments/nemotron-tinker-grpo-scale/artifacts/holdout-sft-epoch4.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo-scale/evaluate.py --split holdout --model-path tinker://5eb88b9c-21cc-55c5-b50a-7980daf76e39:train:0/sampler_weights/000010 --label holdout-grpo-step10 --temperature 0.0 --samples 1 --frozen-holdout-sha256 7c15a9e33d687792cf613e9bd53b9d544dbc400dc35b8aeaa4795b16593d84d1 --out experiments/nemotron-tinker-grpo-scale/artifacts/holdout-grpo-step10.jsonl
```

## Cost, receipts, and cleanup

`artifacts/token-totals.json` contains prompt plus sampled/model-input token
totals. The measured artifact-derived totals are:

| Phase | Tokens |
|---|---:|
| Baseline train + dev | 915,411 |
| SFT data, training, and evaluations | 1,521,920 |
| GRPO Stage 1, Stage 2, and evaluations | 5,855,012 |
| Sealed holdout, three arms | 352,784 |
| **Grand total** | **8,645,127** |

Tinker's `get_billing_usage` returned empty event data for the captured
receipts, so no USD figure is reported. The token-based estimate is well
inside the approved budget envelope.

There are no Tinker serving deployments: sampling clients are ephemeral. The
Node evaluator service is stopped. Checkpoints are retained as evidence.
`artifacts/cleanup-report.json` records the queried checkpoint inventory and
expiry timestamps for:

- SFT run `6a954d26...:train:0` — five checkpoints; `expires_at: null`
- GRPO Stage 1 run `ebce40a2...:train:0` — final training and sampler
  checkpoints; `expires_at: null`
- GRPO Stage 2 run `5eb88b9c...:train:0` — steps 5–40 and final checkpoints;
  intermediate checkpoints have provider expiry timestamps and final
  checkpoints have `expires_at: null`

The cookbook's raw per-iteration rollout dumps are deliberately excluded.
Each GRPO log retains only `config.json`, `metrics.jsonl`, and
`checkpoints.jsonl`; the compact JSONL evaluation rows, summaries, selection
records, telemetry, receipts, and token totals remain in `artifacts/`.

All fixture contacts, tasks, tool observations, and trajectories are synthetic
public-test data; no customer or private trace data is included.
