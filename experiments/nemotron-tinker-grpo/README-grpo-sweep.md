# AutomationBench rank/step GRPO sweep lab note

## Goal and contract

This is a controlled follow-up to the original Nemotron SFT → GRPO arm. The
goal was to compare LoRA ranks 16 and 32 at GRPO steps 20, 40, and 80, while
getting the learning curve from one 80-step run per rank. The actual runs also
evaluated checkpoints at steps 10, 20, 30, 40, 60, and 80.

The fixture is synthetic and offline. The Node AutomationBench evaluator is the
authority for state transitions, terminal reward, split membership, and
holdout authorization.

```text
base model:       nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16
renderer:         nemotron3_disable_thinking
fixture sha256:   0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train/dev/holdout: 48 / 12 / 12 tasks
dataset seed:     7
train sha256:     783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev sha256:       5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
holdout sha256:   a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

SFT used four epochs, batch size 16, learning rate `1e-4`, max length 4096,
and 48 oracle trajectories from train only. GRPO used group size 8, eight
groups per batch, temperature 1.0, learning rate `1e-5`, importance sampling,
constant-reward-group removal, and `save_every=5`.

The renderer is a deliberate deviation from plain `nemotron3`: the action
protocol requires one canonical JSON object per turn, so reasoning traces would
make SFT targets non-canonical.

## Gates and warm starts

The required sanity gate passed:

```text
node --test tests/automationbench-offline.test.mjs       32 passed, 0 failed
node --test tests/automationbench-rl-service.test.mjs     4 passed, 0 failed
oracle train export: 48 rows, every reward 1.0
```

The offline suite also confirmed the reward-hacking sentinel scores 0.0 and
trips forbidden effects. Named examples from the separate sanity check were
`simple-api-crm-close-01` (single-write) and
`simple-api-crm-bulk-owner-01` (multi-write). Malformed tool calls are rejected
and counted by `rollout.py`; they are not silently repaired.

The brief originally described one fixed warm start. The rank comparison
required a rank-matched deviation: a rank-16 state is loaded by a rank-16
client, and a rank-32 state by a rank-32 client. Reusing one rank across both
arms would confound the comparison. Both arms were therefore retrained from
the identical recipe and train-only oracle data, and resumable state was saved
after every epoch.

### SFT selection

Selection rule: highest greedy dev reward; ties select the latest epoch.

| Rank | Epoch 1 | Epoch 2 | Epoch 3 | Epoch 4 | Selected |
|---:|---:|---:|---:|---:|---:|
| 16 | 0.861111 | 0.736111 | **1.000000** | 0.944444 | epoch 3 |
| 32 | 0.819444 | 0.777778 | 0.944444 | **1.000000** | epoch 4 |

Selected rank-16 sampler/state:

```text
tinker://a545059e-0e23-5938-b1f6-9501e2e58419:train:0/sampler_weights/sft-epoch3
tinker://a545059e-0e23-5938-b1f6-9501e2e58419:train:0/weights/sft-epoch3-state
```

Selected rank-32 sampler/state:

```text
tinker://79c8c5c5-0201-51fa-ad00-fc0e4e610265:train:0/sampler_weights/sft-epoch4
tinker://79c8c5c5-0201-51fa-ad00-fc0e4e610265:train:0/weights/sft-epoch4-state
```

Full per-epoch URIs are in `artifacts/sft-selection-rank16.json` and
`artifacts/sft-selection-rank32.json`; their row-level summaries live under
`artifacts/sweep/rank16/legacy/` and `artifacts/sweep/rank32/legacy/`.

## Greedy GRPO learning curve

All rows below are greedy dev evaluations over 12 tasks. Train reward is the
free per-step aggregate extracted from `metrics.jsonl`.

| Rank | Step | Dev reward | Dev strict | Dev forbidden | Dev env steps | Dev malformed | Train reward | Train forbidden | Train env steps |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 16 | 10 | 1.000000 | 1.000000 | 0.0000 | 2.4167 | 1 | 0.750000 | 0.1667 | 2.5787 |
| 16 | 20 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.687500 | 0.2083 | 2.6381 |
| 16 | 30 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.890625 | 0.0313 | 2.4538 |
| 16 | 40 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.875000 | 0.3125 | 1.9818 |
| 16 | 60 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 1.000000 | 0.0000 | 1.6667 |
| 16 | 80 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.958333 | 0.0000 | 3.3778 |
| 32 | 10 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 1 | 0.820833 | 0.0000 | 2.4458 |
| 32 | 20 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.796875 | 0.0938 | 2.4762 |
| 32 | 30 | 1.000000 | 1.000000 | 0.0000 | 2.5000 | 0 | 0.875000 | 0.0625 | 2.7945 |
| 32 | 40 | 1.000000 | 1.000000 | 0.0000 | 2.5000 | 0 | 1.000000 | 0.0000 | 1.6667 |
| 32 | 60 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 0.875000 | 0.0000 | 1.7600 |
| 32 | 80 | 1.000000 | 1.000000 | 0.0000 | 2.3333 | 0 | 1.000000 | 0.0000 | 1.8462 |

The chart is `artifacts/grpo-sweep-learning-curve.svg`. Source curve artifacts
are `grpo-rank16-train-vs-dev-curve.json` and
`grpo-rank32-train-vs-dev-curve.json`; their checkpoint/metrics sources are
under `artifacts/sweep/rank16/` and `artifacts/sweep/rank32/`.

The greedy dev metric is saturated: rank-16 SFT already reached 1.000000, and
every GRPO checkpoint for both ranks also reached 1.000000. With 12 tasks, one
task is approximately 0.083333 of the mean, so this metric cannot distinguish
the six points within a rank.

## Registered stress tie-break

The preregistration artifact is `artifacts/selection-preregistration.json`.
Stress used dev only, temperature 1.0, four samples per task, and the same
authoritative evaluator.

| Candidate | Stress reward | Strict pass | Forbidden effects | Env steps | Malformed calls |
|---|---:|---:|---:|---:|---:|
| Base | 0.590278 | 0.520833 | 0.1250 | 4.6875 | 2 |
| SFT rank 16 | 0.802083 | 0.750000 | 0.1042 | 2.4375 | 4 |
| SFT rank 32 | 0.767361 | 0.708333 | 0.0417 | 2.3750 | 4 |
| Rank 16 / 10 | 0.888889 | 0.833333 | 0.0000 | 2.6042 | 7 |
| Rank 16 / 20 | 0.899306 | 0.875000 | 0.0417 | 2.6875 | 2 |
| Rank 16 / 30 | 0.951389 | 0.916667 | 0.0000 | 2.4167 | 3 |
| Rank 16 / 40 | 0.927083 | 0.916667 | 0.0833 | 2.6667 | 3 |
| **Rank 16 / 60** | **1.000000** | **1.000000** | **0.0000** | **2.3958** | **0** |
| Rank 16 / 80 | 0.979167 | 0.979167 | 0.0208 | 2.4792 | 2 |
| Rank 32 / 10 | 0.888889 | 0.854167 | 0.0417 | 2.8333 | 2 |
| Rank 32 / 20 | 0.958333 | 0.937500 | 0.0000 | 2.4375 | 5 |
| Rank 32 / 30 | 0.934028 | 0.916667 | 0.0417 | 2.4375 | 4 |
| Rank 32 / 40 | 0.979167 | 0.979167 | 0.0208 | 2.4792 | 0 |
| Rank 32 / 60 | 0.951389 | 0.937500 | 0.0208 | 2.4375 | 1 |
| Rank 32 / 80 | 0.979167 | 0.979167 | 0.0208 | 2.3542 | 1 |

The combined artifact is `artifacts/dev-stress-combined-curve.json`.
The preregistered rule selected **rank 16, GRPO step 60**: all candidates tied
on greedy dev reward, and this point had the highest stress reward.

## Reward-hacking and overfit checks

The selected configuration had zero forbidden effects, zero malformed calls,
and a mean of 2.3958 tool calls per stress task. Across the greedy curves,
train reward rose to 1.0 at some checkpoints while dev stayed flat at 1.0;
this is a train/dev divergence warning about the ceiling, not evidence of
generalization. Train-side forbidden effects were intermittent (rank 16 peaked
at 0.3125 at step 40; rank 32 peaked at 0.0938 at step 20), but did not appear
on greedy dev. Rank-16 step 80 also showed stress reward falling to 0.979167
with two malformed calls and nonzero forbidden effects, consistent with
diminishing returns rather than a clear catastrophic collapse.

## Reference and sealed holdout

Greedy reference results (temperature 0, one sample) are in
`artifacts/reference-greedy-results.json`:

| Candidate | Train mean | Train strict | Dev mean | Dev strict |
|---|---:|---:|---:|---:|
| Base | 0.861111 | 0.833333 | 0.694444 | 0.666667 |
| SFT rank 16 | 0.954861 | 0.937500 | 1.000000 | 1.000000 |
| SFT rank 32 | 0.944444 | 0.916667 | 0.944444 | 0.916667 |

After selection was sealed, exactly one holdout evaluation was run:

```text
config: rank 16, GRPO step 60
mean reward: 1.000000
strict pass: 1.000000
temperature/samples: 0.0 / 1
holdout tasks: 12
```

Artifacts:

```text
sealed-holdout-rank16-step60.jsonl
sealed-holdout-rank16-step60.summary.json
sealed-holdout-rank16-step60.usage.json
sealed-holdout-record.json
```

The frozen holdout hash matched. The run was after selection and did not
influence any choice. No stress holdout evaluation, alternate holdout config,
or retry was performed.

## Receipts, failures, and cleanup

Approximate phase accounting:

| Phase | Wall clock | Prompt/input tokens | Sampled/action tokens |
|---|---:|---:|---:|
| Rank-16 SFT | 549.3 s | ~386,725 | ~15,172 |
| Rank-32 SFT | 419.6 s | ~383,025 | ~16,360 |
| Rank-16 GRPO stage 1 smoke | 90.7 s | recorded in smoke log | recorded in smoke log |
| Rank-16 GRPO stage 2 | 3675.7 s | 2,734,699 train + 100,284 dev | 151,875 train + 5,576 dev |
| Rank-32 GRPO stage 1 smoke | 131.7 s | recorded in smoke log | recorded in smoke log |
| Rank-32 GRPO stage 2 | 3596.8 s | 2,590,399 train + 102,787 greedy dev + 437,529 stress dev | 145,070 train + 5,680 greedy dev + 24,051 stress dev |
| Sealed holdout | recorded by usage/eval artifacts | 16,265 | 897 |

The rank-16 and rank-32 GRPO receipts are
`grpo-rank16-phase-receipt.json` and `grpo-rank32-phase-receipt.json`.
Billing receipts preserve the raw response from
`/api/v1/get_billing_usage`: HTTP 404 `{"detail":"Not Found"}`. Therefore no
authoritative USD amount is available or reported.

Failures and deviations encountered:

1. The SDK pyqwest path failed with `invalid peer certificate: UnknownIssuer`;
   the run used the REST-configured client and cookbook client-reuse shim.
2. The billing endpoint returned 404, so tokens and wall clock are the
   accounting receipts instead of invented dollars.
3. Rank-16 SFT dev dipped to 0.736111 at epoch 2 before reaching 1.000000 at
   epoch 3; the pre-registered best-dev/latest-tie rule was not changed.

`artifacts/cleanup-report-sweep.json` enumerates the six training runs, their
saved checkpoints, and their session metadata. The runs and checkpoints are
retained as evidence, not deployments. No always-on serving resource existed,
and no local Node RL-service process remained. The installed Tinker resource
surface provides no session stop/delete operation; re-query confirmed all
retained checkpoint resources remain discoverable.

### Rule of thumb

On this saturated 12-task fixture, do enough RL to reach the stress peak
(about 60 steps for rank 16); beyond that, additional steps have diminishing
returns and should require a larger or harder dev set to justify their cost.
