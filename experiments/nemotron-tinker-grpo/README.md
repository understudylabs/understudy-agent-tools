# AutomationBench Nemotron SFT → GRPO arm

This directory contains a reproducible, train-only-warm-started SFT → GRPO
research arm for the synthetic offline AutomationBench fixture. The Node
evaluator in `src/automationbench-offline.ts` is the sole authority for state
transitions, terminal reward, split membership, and holdout authorization.

## Arm and provenance

- Base model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- LoRA rank: `32`
- RL dataset seed: `7`
- SFT data: 48 oracle trajectories from `train`
- GRPO: 40 steps, group size 8, 8 groups per batch, temperature 1.0,
  `importance_sampling`, learning rate `1e-5`, constant-reward filtering
  enabled
- Evaluation: greedy temperature 0.0, one sample per task

The renderer and split provenance are:

```text
fixture_sha256: 0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train:         783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev:           5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
holdout:       a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
counts:        train 48, dev 12, holdout 12
```

`nemotron3_disable_thinking` is a deliberate deviation from the plain
`nemotron3` renderer. The action protocol requires one canonical JSON object
per turn; reasoning traces would make SFT targets non-canonical and increase
token cost.

## Results

All values below are means over the complete split. Strict pass means reward
exactly `1.0`.

| Arm | Train mean | Train strict | Dev mean | Dev strict | Holdout mean | Holdout strict |
|---|---:|---:|---:|---:|---:|---:|
| Base | 0.895833 | 0.875000 | 0.861111 | 0.833333 | 0.944444 | 0.916667 |
| SFT epoch 4 | 0.975694 | 0.958333 | 0.944444 | 0.916667 | 0.944444 | 0.916667 |
| SFT + GRPO step 20 | 0.979167 | 0.979167 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |

The SFT lift over base and the GRPO marginal lift over SFT are separate:

| Split | SFT lift over base | GRPO lift over SFT |
|---|---:|---:|
| Train | +0.079861 | +0.003472 |
| Dev | +0.083333 | +0.055556 |
| Holdout | +0.000000 | +0.055556 |

Holdout per-band means:

| Band | Base | SFT epoch 4 | GRPO step 20 |
|---|---:|---:|---:|
| Discovery | 1.000000 | 1.000000 | 1.000000 |
| Multi-write | 0.833333 | 0.833333 | 1.000000 |
| Single-write | 1.000000 | 1.000000 | 1.000000 |

The holdout has only 12 tasks: one task changes the mean by approximately
`0.083333`. For strict-pass rates, a binomial-ish standard error is
`sqrt(p(1-p)/12)` and can be as high as about `0.144` near `p=0.5` (roughly
`±0.28` for a 95% interval). Partial-credit means are not binomial, but the
same small-sample warning applies. Do not over-read one- or two-task
differences.

### GRPO curve

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

The cookbook's raw per-iteration rollout dumps (~108 MB) are deliberately not
committed; `artifacts/grpo-stage*-log/` keeps their `config.json`,
`metrics.jsonl`, and `checkpoints.jsonl`.

### Group-variance progression

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
   AutomationBench result.

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
  `partialCredit` from `src/automationbench-offline.ts` reached over HTTP,
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

Start the evaluator service:

```bash
node scripts/automationbench-rl-service.mjs
```

Regenerate oracle data:

```bash
node scripts/automationbench-oracle-trajectories.mjs \
  --out experiments/nemotron-tinker-grpo/artifacts/oracle-train.jsonl
```

Baseline evaluation:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo/evaluate.py \
  --split train --model-path base --label baseline-train \
  --temperature 0.0 --samples 1 \
  --out experiments/nemotron-tinker-grpo/artifacts/baseline-train.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo/evaluate.py \
  --split dev --model-path base --label baseline-dev \
  --temperature 0.0 --samples 1 \
  --out experiments/nemotron-tinker-grpo/artifacts/baseline-dev.jsonl
```

SFT:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo/sft.py
```

GRPO Stage 1 and Stage 2:

```bash
/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo/grpo.py --stage 1 --max-steps 2

/home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-grpo/grpo.py --stage 2 --max-steps 40
```

The sealed holdout commands used for this arm were:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo/evaluate.py --split holdout --model-path base --label holdout-base --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/nemotron-tinker-grpo/artifacts/holdout-base.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo/evaluate.py --split holdout --model-path tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/sampler_weights/sft-epoch4 --label holdout-sft-epoch4 --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/nemotron-tinker-grpo/artifacts/holdout-sft-epoch4.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/nemotron-tinker-grpo/evaluate.py --split holdout --model-path tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020 --label holdout-grpo-step20 --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/nemotron-tinker-grpo/artifacts/holdout-grpo-step20.jsonl
```

The three holdout runs were executed exactly once. They must not be rerun.

## Scale-up arm addendum

This addendum records the longer SFT-warm-start plus GRPO comparison run on
the same public synthetic AutomationBench fixture. It does not replace the
earlier #402 reproduction sections above.

### Configurations and isolation

The arm compares:

| label | LoRA rank | shaping |
| --- | ---: | --- |
| `r32-none` | 32 | off |
| `r32-shaped` | 32 | on |
| `r16-shaped` | 16 | on |

All three use seed 7, 48 train tasks, group size 16, six groups per batch,
learning rate `1e-5`, importance sampling, constant-reward group removal, and
up to 150 GRPO steps. The rank-32 runs resume the #402 rank-32 SFT epoch-4
state. The rank-16 run uses a separately trained rank-16 SFT epoch-4 state.
Every RL task is asserted to have `split == "train"`. Synthetic workflow tasks
are used only for transfer evaluation and never enter GRPO training or
AutomationBench checkpoint selection.

### Train-time reward shaping

The evaluator remains authoritative for every reported score. Intermediate
transitions receive reward `0.0`; shaping is applied only to the terminal
transition and only to the scalar seen by GRPO:

```text
excess_ratio = clamp(
  (env_steps - oracle_steps[task_id]) / max(1, oracle_steps[task_id]),
  0,
  1,
)
noexit = 1.0 if max_turns ended the episode, otherwise 0.0
soft = min(
  0.20,
  0.10 * excess_ratio + 0.10 * noexit,
)
shaped = terminal_partial_credit * (1 - soft)
       - 0.15 * min(1, forbidden_effect_count)
```

`terminal_reward` is always the raw evaluator `partialCredit`; `shaped_reward`
is the optimization scalar. The length/no-clean-stop term is multiplicative
and capped at 20%, so it cannot outweigh an outcome difference and cannot
create an incentive to quit before earning terminal credit. The
forbidden-write term is additive because `partialCredit` already returns zero
for forbidden effects; a multiplicative penalty would therefore have zero
additional learning signal. Doing nothing still earns zero.

Oracle step counts are derived once from train-only oracle trajectories and
missing train counts are fatal. Forbidden effects are read from terminal
`/finish`.

### DEV saturation and stopping rule

The initial DEV curve reached raw mean `1.0000` almost immediately on the
12-task DEV split. Because one task is approximately `0.0833` of the mean,
raw reward alone is too coarse to justify stopping. The arm therefore requires
at least 100 GRPO steps. Early stopping is permitted only after both raw DEV
reward and all of these behavioral metrics have remained unchanged for three
consecutive DEV evaluations:

- mean environment steps;
- explicit-finish rate;
- forbidden-effect rate;
- parse-error rate.

The complete curves are recorded in:

```text
artifacts/r32-none-dev-curve.jsonl
artifacts/r32-shaped-dev-curve.jsonl
artifacts/r16-shaped-dev-curve.jsonl
```

The runs reached the required floor; all three raw DEV curves stayed at
`1.0000` after their initial evaluation. Current final values and selection
are:

```text
GRPO DEV floor reached:      r32-none=105, r32-shaped=105, r16-shaped=105
DEV leaderboard:             artifacts/selection-1785634167.json
DEV tie-break winner:        r32-none step 15
20-step vs 100+ conclusion:  no measurable DEV improvement; curves flat
```

All 21 evaluated DEV leaderboard rows (7 per configuration, steps 15 through
105) have raw mean `1.0000`, mean environment steps `2.3333`, and zero
forbidden effects. The first three tie-break criteria therefore remain tied;
the earliest evaluated checkpoint, step 15, decides. The label ordering makes
`r32-none` the artifact's representative winner, but this is not evidence that
unshaped rank 32 is better than either shaped arm.

In plain terms, the three arms are indistinguishable on DEV. The selection was
decided by the arbitrary, pre-registered earliest-step tie-break, not by a
measurable quality or behavioral difference.

The former `_evaluate_stage2_checkpoints` helper is retained as historical
#402 workflow code. It is superseded by the in-process DEV curve and the
DEV-only selection artifact above; it is not called by `main()`, so no
evaluation coverage was lost.

### DEV-only selection

Before either holdout is accessed, the selection helper writes:

```text
artifacts/selection-<timestamp>.json
```

It includes every checkpoint from all three configurations and applies this
rule, in order:

1. highest raw DEV `partialCredit` mean;
2. lower mean DEV `env_steps`;
3. fewer DEV forbidden effects;
4. earliest step.

Because raw DEV reward is pinned at its ceiling, the artifact must state
explicitly when a behavioral tie-break decides the winner. Synthetic transfer
metrics are descriptive only and must not enter this selection.

### Synthetic workflow transfer probe

The separate `synthetic-workflow` backend is an offline sibling fixture with
9 tasks (5 train, 2 DEV, 2 holdout), six families, seed 7, and a wider
endpoint/state surface. Its benchmark and hashes are distinct:

```text
benchmark: synthetic-workflow-shapes-offline
fixture:   5f8d2aa038fa06afe579595aec82ca4c08c17c01c912ebdca4cd0cb9cc94ca9b
train:     4ad271dc23278f696dcea670bf5ebb6fdd35fb8cd4fe76c38a07ace17ca4bf9b
dev:       8b7dec5f251c8b43b8e3540fd3ef26adc367494be3b13bebf6e65dc930fd3b0e
holdout:   01cec7ca0034b6a803070e9fc83e62be1ccac6da77df5bb6d29e4ec25d711326
```

Transfer evaluations use train+DEV only, greedy decoding, and are reported
separately from AutomationBench. The
selected checkpoint evaluations are:

```text
base train / DEV:           0.200 / 0.000
#402 rank-32 SFT train/DEV: 0.333 / 0.000
selected r32-none:          0.333 / 0.000
selected r32-shaped:        0.333 / 0.000
selected r16-shaped:        0.333 / 0.000
```

The three selected GRPO checkpoints are all their respective step-15
samplers. On the corrected synthetic DEV probe, each had zero reward, mean
model turns `8.0`, `100%` explicit finish, `50%` parse-error rate, and
`100%` forbidden-effect rate. These are descriptive transfer results only;
they did not affect the AutomationBench selection.

An adapter gate was added before interpreting transfer results. Oracle replay
through the HTTP adapter scores 1.0 with zero forbidden effects on all 5
synthetic train and 2 synthetic DEV tasks. A do-nothing policy scores 0.0,
and an out-of-scope write scores 0.0 while recording its forbidden effect.

The first transfer run was invalid: the adapter's synthetic `/reset` response
accidentally returned the AutomationBench system prompt. Those artifacts must
not be used as results. The adapter was corrected to return the synthetic
protocol, endpoint catalog, and tool schemas, and the transfer runs were
repeated. Corrected base results were `0.200` train / `0.000` DEV; corrected
#402 rank-32 SFT results were `0.333` train / `0.000` DEV. The corrected
failure-mode artifact is:

```text
artifacts/synthetic-transfer-v2-failure-modes.json
```

These corrected results show genuine remaining transfer difficulty, including
incorrect endpoint/method behavior and forbidden effects on DEV. The transfer
probe is the surface with meaningful headroom; it is a generalization probe,
not an upstream AutomationBench result or a model-selection input.

After approval, each sealed holdout was evaluated exactly once on the selected
`r32-none` step-15 checkpoint. AutomationBench holdout scored `1.0000`
(`12/12` strict passes); the synthetic transfer holdout scored `0.2500`
(`0/2` strict passes). The AutomationBench result is recorded in
`artifacts/automationbench-r32-none-selected-holdout.summary.json`; the
synthetic transfer result is recorded separately in
`artifacts/synthetic-transfer-r32-none-selected-holdout.summary.json`.

### Scale-up results

All values are raw evaluator `partialCredit`, greedy, one sample per task.
Base and SFT holdout rows are the #402 sealed values and were not rerun.

| Arm | Train | Dev | Holdout |
| --- | ---: | ---: | ---: |
| Base | 0.8958 | 0.8611 | 0.9444 |
| SFT epoch 4 (rank 32, #402) | 0.9757 | 0.9444 | 0.9444 |
| `r32-none` step 15 | 0.9792 | 1.0000 | 1.0000 (sealed) |
| `r32-shaped` step 15 | 1.0000 | 1.0000 | not run |
| `r16-shaped` step 15 | 1.0000 | 1.0000 | not run |

Train is the only split with enough resolution to separate the arms, and it
separates them in one place: the unshaped control leaves the multi-write band
at `0.9375`, while both shaped arms reach `1.0000` on every band. That the
effect appears independently at rank 32 and rank 16 makes it more than a single
lucky run, but it is a **train** result on the split the policy was optimized
against, so it is not evidence of generalization. Dev and holdout cannot
confirm or refute it: both are saturated at `1.0000` for every arm.

### Caveats and reporting index

Per-config raw/shaped learning curves, per-band train/DEV results, over-acting
metrics, token and wall-clock receipts, and the final billing-usage query:

```text
learning curves:             artifacts/*-learning-curve.jsonl
single-write/discovery/multi-write: artifacts/*selected-*.summary.json
env steps/model turns:       artifacts/scaleup-report.json
explicit-finish rate:        artifacts/scaleup-report.json
parse-error rate:            artifacts/scaleup-report.json
forbidden-effect rate:       artifacts/scaleup-report.json
token totals and receipts:   artifacts/*grpo-stage2*.usage.json
get_billing_usage:           artifacts/billing-usage-final.json
```

The 12-task AutomationBench DEV and holdout splits are coarse (one task is
about `0.0833` of a mean), so a saturated DEV score is weak evidence by itself.
The synthetic fixture is an offline public test fixture with its own verifier
and hashes; it is not an upstream AutomationBench result. Both holdouts were
accessed exactly once, after the DEV selection artifact and every descriptive
transfer evaluation were already written; neither may be rerun.

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
