# Cedar-synthetic Nemotron SFT → GRPO arm

This directory contains a reproducible SFT → GRPO research arm for the
sanitized Cedar-shaped synthetic fixture. The Node evaluator in
`src/synthetic-workflow-offline.ts` is the sole authority for state
transitions, terminal reward, split membership, and holdout authorization.

## Arm and provenance

- Base model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- LoRA rank: `32`
- RL dataset seed: `7`
- SFT data: 48 oracle trajectories regenerated from `train` only
- GRPO: 40 steps, group size 8, 8 groups per batch, temperature 1.0,
  `importance_sampling`, learning rate `1e-5`, constant-reward filtering
  enabled
- Evaluation: greedy temperature 0.0, one sample per task

The renderer and split provenance are:

```text
fixture_sha256: eb1ba85916c7a026928399d448cd1d9f9db7d1f8043b4208690d61c7ced707a7
train:         95e862ec87a66b6e75d3456c201dd1fdf22f72310ee61781322f1bc13acd28e5
dev:           e4a3d2c1e9f2064d4da7a49dd7da9d3ca0019f6826f523383af2d924b4165ca3
holdout:       6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144
counts:        train 48, dev 12, holdout 12
```

`nemotron3_disable_thinking` is a deliberate deviation from the plain
`nemotron3` renderer. The action protocol requires one canonical JSON object
per turn; reasoning traces would make SFT targets non-canonical and increase
token cost.

## Results

The first Cedar run used the pre-calibration fixture and is superseded. Its
artifacts remain as diagnostic evidence in `artifacts/`, but its scores must
not be reported. The repaired run below uses the fixture hash above and
selects checkpoints on dev only.

All values below are means over the complete split. Strict pass means reward
exactly `1.0`.

| Arm | Train mean | Train strict | Dev mean | Dev strict | Holdout mean | Holdout strict |
|---|---:|---:|---:|---:|---:|---:|
| Base | 0.052083 | 0.041667 | 0.083333 | 0.083333 | 0.000000 | 0.000000 |
| SFT epoch 1 | 0.067708 | 0.062500 | 0.104167 | 0.083333 | 0.083333 | 0.083333 |
| SFT + GRPO step 40 | 0.083333 | 0.062500 | 0.166667 | 0.166667 | 0.000000 | 0.000000 |

The SFT lift over base and the GRPO marginal lift over SFT are separate:

| Split | SFT lift over base | GRPO lift over SFT |
|---|---:|---:|
| Train | +0.015625 | +0.015625 |
| Dev | +0.020833 | +0.062500 |
| Holdout | +0.083333 | -0.083333 |

Holdout per-band means:

| Band | Base | SFT epoch 4 | GRPO step 20 |
|---|---:|---:|---:|
| Discovery | 0.000000 | 0.200000 | 0.000000 |
| Multi-write | 0.000000 | 0.000000 | 0.000000 |
| Single-write | 0.000000 | 0.000000 | 0.000000 |

The holdout has only 12 tasks: one task changes the mean by approximately
`0.083333`. For strict-pass rates, a binomial-ish standard error is
`sqrt(p(1-p)/12)` and can be as high as about `0.144` near `p=0.5` (roughly
`±0.28` for a 95% interval). Partial-credit means are not binomial, but the
same small-sample warning applies. Do not over-read one- or two-task
differences.

### GRPO curve

The curve below is retained as historical context from the superseded
pre-calibration run and is not part of the repaired result. The repaired
per-step records are in `artifacts/grpo-stage2-log.tail.txt` and the
checkpoint/evaluation JSON artifacts.

Training mean group reward and constant-reward drop fraction rose toward
saturation:

| Steps | Mean group reward | Constant-group fraction |
|---|---:|---:|
| 1–10 | 0.850521 | 0.425 |
| 11–20 | 0.923698 | 0.563 |
| 21–30 | 0.950781 | 0.688 |
| 31–40 | 0.963542 | 0.750 |

The complete per-step curve is in `artifacts/grpo-stage2-telemetry.json` and
`artifacts/grpo-results.json`. Dev saturated at step 20; the exact selection
rule was highest dev reward with earliest-step tie-break, so step 20 was
selected.

The cookbook's raw per-iteration rollout dumps are deliberately not
committed; only approximately 2,000-line tails are retained.

### Group-variance progression

The following table is also from the superseded run and is retained only for
diagnostic provenance.

These are the same eight train tasks, temperature 1.0, eight samples per
task:

| Arm | Mean reward | Nonzero-variance groups |
|---|---:|---:|
| Base | 0.656250 | 8/8 |
| SFT epoch 4 | 0.906250 | 2/8 |
| GRPO step 20 | 0.984375 | 1/8 |

The brief's prior “zero reward variance without warm-start” finding did **not**
reproduce here. The base model had nonzero variance in 8/8 probe groups, so
SFT warm-start was not strictly required for GRPO to have signal on this
fixture.

## Caveats

1. The base model already scored approximately 0.86–0.90 on train/dev, so
   available headroom was small and absolute lifts are correspondingly small.
2. Dev and holdout contain only 12 tasks each; see the uncertainty warning
   above.
3. This is a synthetic, offline fixture and is **not** an upstream
   Cedar-synthetic result.

## Deviations from the brief

- `nemotron3_disable_thinking` is used instead of plain `nemotron3` so each
  assistant turn is one canonical JSON action.
- The environment is implemented as a cookbook-native
  `tinker_cookbook.rl.types.Env` and run through
  `tinker_cookbook.rl.train.main`, rather than installing the `verifiers`
  package. The cookbook owns group-relative advantages and token-level
  importance sampling, avoiding a hand-rolled high-risk RL implementation.
  This is Verifiers-style MultiTurnEnv structure without the package. The
  Node service is the verifier, and terminal reward is literally
  `partialCredit` from `src/synthetic-workflow-offline.ts` reached over HTTP,
  so remote reward equals local reward by construction.
- The action protocol uses JSON parsed through the sampling/renderer path
  rather than `tools=`; the latter raises `NotImplementedError` for this
  renderer.

## Reproduction

These commands assume a Python environment holding the Thinking Machines
`tinker` and `tinker-cookbook` packages; the paths below are the ones used for
this run (`/home/ubuntu/tinker-venv/bin/python`), so substitute your own
interpreter. Provide `TINKER_API_KEY` only through the process environment.
Never write the key to an artifact.

Start the Cedar evaluator service:

```bash
node scripts/synthetic-workflow-rl-service.mjs
```

Regenerate oracle data:

```bash
node scripts/synthetic-workflow-oracle-trajectories.mjs \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/oracle-train.jsonl
```

Baseline evaluation:

```bash
/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py \
  --split train --model-path base --label baseline-train \
  --temperature 0.0 --samples 1 \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/base-train.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py \
  --split dev --model-path base --label baseline-dev \
  --temperature 0.0 --samples 1 \
  --out experiments/cedar-synthetic-tinker-grpo/artifacts/base-dev.jsonl
```

SFT:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/sft.py
```

GRPO Stage 1 and Stage 2:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/grpo.py --stage 1 --max-steps 2

/home/ubuntu/tinker-venv/bin/python \
  experiments/cedar-synthetic-tinker-grpo/grpo.py --stage 2 --max-steps 40
```

The sealed holdout commands used for this arm were:

```bash
/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path base --label holdout-base-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-base-sealed.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path tinker://f59c948b-5fb7-5ac3-8c37-f003c535953a:train:0/sampler_weights/sft-epoch2 --label holdout-sft-epoch2-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-sft-epoch2-sealed.jsonl

/home/ubuntu/venvs/tinker/bin/python experiments/cedar-synthetic-tinker-grpo/evaluate.py --split holdout --model-path tinker://58055612-dcc4-5fae-a14b-f1f8156ca380:train:0/sampler_weights/000010 --label holdout-grpo-step10-sealed --temperature 0.0 --samples 1 --frozen-holdout-sha256 6144b6277de574db819efe86b459409f4a262b266db650d3720729dac50f8144 --out experiments/cedar-synthetic-tinker-grpo/artifacts/holdout-grpo-step10-sealed.jsonl
```

The three holdout runs were executed exactly once. They must not be rerun.

## Cost, receipts, and cleanup

Measured token totals are prompt plus sampled/model-input tokens. The
baseline handoff used `426,680` tokens. SFT used `356,662` hosted tokens and
about `396.9s` across training, data preparation, and recorded evaluations.
GRPO Stage 1 used `213,219` tokens and `113.5s`. GRPO Stage 2 used
`4,280,921` tokens across training and its requested evaluations, with
`1,773.1s` training wall-clock. The sealed holdout used `72,129` tokens.
The summed total across all phases is `5,349,611` tokens.

Tinker's `get_billing_usage` initially returned empty events. The final retry
returned events but no dollar amounts; the returned event token total was
`575,178`, which is a provider billing view and is not substituted for the
artifact-derived phase totals above.

The cleanup query found these arm training runs:

- SFT run `e3e3d392...:train:0`: epoch 1–4 sampler checkpoints and the epoch-4
  resumable state; all reported `expires_at: null`.
- GRPO Stage 1 run `91eac422...:train:0`: final sampler and state; both
  reported `expires_at: null`.
- GRPO Stage 2 run `efb1352d...:train:0`: steps 5–40, final sampler/state.
  Steps 5–35 reported expiry on 2026-08-08; step 40 and final checkpoints
  reported `expires_at: null`. The selected step-20 sampler and state had
  expiry 2026-08-08T22:45:40Z and 2026-08-08T22:45:38Z respectively.

No checkpoints were deleted. If cleanup were requested, it would delete the
SFT epoch samplers/state, the Stage 1 final sampler/state, and every Stage 2
step/final sampler/state listed in `artifacts/grpo-stage2-checkpoints.json`;
the current user decision is to retain all as evidence.

`list_sessions(limit=100)` returned 100 sessions (the response was
paginated/truncated at the requested limit). Tinker has no always-on serving
deployment for this arm: sampling clients are ephemeral. No serving resource
was left running. The local Node environment service was stopped and no
process remained listening.

All fixture contacts, tasks, tool observations, and trajectories in these
artifacts are synthetic public-test data; no customer or private trace data is
included.
