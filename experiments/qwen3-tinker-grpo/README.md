# AutomationBench Qwen3 SFT → GRPO arm

This directory contains a reproducible verifier-RL research arm for the
synthetic, offline AutomationBench fixture. The question is whether the
Nemotron-style verifier-RL recipe generalizes to a weaker base model.

The Node evaluator in `src/automationbench-offline.ts` is the authority for
state transitions, terminal reward, split membership, and holdout
authorization. The holdout was run exactly once and must not be rerun.

## Arm and provenance

- Base model: `Qwen/Qwen3-8B`
- Renderer: `qwen3_disable_thinking`
- LoRA rank: `32`
- Dataset seed: `7`
- SFT data: 48 oracle trajectories from `train`
- GRPO: 40 steps, group size 8, 8 groups per batch, temperature 1.0,
  `importance_sampling`, learning rate `1e-5`, constant-reward filtering
  enabled
- Evaluation: greedy temperature 0.0, one sample per task
- Recipe: identical to the completed Nemotron arm, apart from base model and
  renderer names

Fixture and split provenance:

```text
fixture_sha256: 0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train:         783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev:           5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
holdout:       a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
counts:        train 48, dev 12, holdout 12
```

The Qwen3 renderer deliberately disables visible thinking traces. The action
protocol requires one canonical JSON object per turn; the evaluator supplies
tool observations and permits up to 12 turns for recovery.

The arm ran against the pre-generalization AutomationBench service. The
merged generalized service restores the benchmark-specific AutomationBench
system prompt, including its endpoint catalog and JSON observation instruction,
and serves a byte-identical AutomationBench contract. This was verified by
starting the merged service with its default benchmark, comparing both
`/protocol` and `/reset` `system_prompt` values byte-for-byte against
`messages[0].content` in `artifacts/holdout-base.jsonl`, and separately
checking that the synthetic-workflow service retains the generic prompt.

## Results

All values are means over the complete split. Strict pass means reward exactly
`1.0`. These values are recorded in the corresponding `*.summary.json`
artifacts.

| Arm | Train mean | Train strict | Dev mean | Dev strict | Holdout mean | Holdout strict |
|---|---:|---:|---:|---:|---:|---:|
| Base | 0.767361 | 0.708333 | 0.750000 | 0.750000 | 0.680556 | 0.583333 |
| SFT epoch 4 | 0.923611 | 0.895833 | 0.972222 | 0.916667 | 0.833333 | 0.833333 |
| SFT + GRPO step 20 | 1.000000 | 1.000000 | 1.000000 | 1.000000 | 1.000000 | 1.000000 |

### Separate lift accounting

SFT lift over base and GRPO marginal lift over SFT are separate:

| Split | SFT lift over base | GRPO marginal lift over SFT |
|---|---:|---:|
| Train | +0.156250 | +0.076389 |
| Dev | +0.222222 | +0.027778 |
| Holdout | +0.152778 | +0.166667 |

The weaker base's total holdout lift is `+0.319444` from base to GRPO, with
GRPO contributing `+0.166667` after SFT.

The band decomposition on holdout is not monotonic. SFT raised discovery
(`0.500000 → 1.000000`) and single-write (`0.750000 → 1.000000`) but
**regressed** multi-write (`0.791667 → 0.500000`): `crm-disambiguate-06` went
`1.000000 → 0.000000` and `mail-send-and-close-06` went `0.666667 → 0.000000`,
while `crm-mail-churn-06` went `0.500000 → 1.000000`. GRPO's entire
marginal lift is the repair of exactly that band (`0.500000 → 1.000000`);
discovery and single-write were already saturated when GRPO started. This
matches the Nemotron arm, where GRPO's marginal lift was also confined to
multi-write, and is the clearest signal in the run that terminal-reward RL is
doing something SFT on oracle trajectories cannot: recovering multi-action
sequences that imitation alone gets wrong.

### Holdout per-band means

| Band | Base | SFT epoch 4 | GRPO step 20 |
|---|---:|---:|---:|
| Discovery | 0.500000 | 1.000000 | 1.000000 |
| Multi-write | 0.791667 | 0.500000 | 1.000000 |
| Single-write | 0.750000 | 1.000000 | 1.000000 |

### Comparison with the Nemotron arm

The completed Nemotron arm reported:

```text
base holdout: 0.944444
SFT holdout:  0.944444
GRPO holdout: 1.000000
GRPO marginal lift: +0.055556
```

Qwen3 therefore shows a larger absolute opportunity on this harness:
`0.680556 → 1.000000`, total lift `+0.319444`, with a GRPO marginal lift of
`+0.166667`. This is evidence that the verifier-RL recipe generalized to the
weaker base in this run, not evidence that the same lift will hold on other
benchmarks or seeds.

## Honest premise correction

The research brief expected approximately `0.24` train and `0.083` dev for the
base model, based on PR #400's plain zero-shot leaderboard. This arm measured:

```text
base train:   0.767361
base dev:     0.750000
base holdout: 0.680556
```

The discrepancy is attributed to the harness rather than chased as a model
anomaly: this arm uses the JSON one-object action protocol, the
`qwen3_disable_thinking` renderer, tool-observation feedback, and up to 12
turns with recovery. Those are materially different from a plain zero-shot
evaluation. The “large headroom” premise was therefore only partly true:
headroom remained real, but the base model was substantially stronger under
this tool-use harness than the brief assumed.

## Failure modes

### Did the base collapse into repetition?

No. The base did not collapse into the known terminal-token repetition mode.
It did show ceiling-hitting and looping behavior, and SFT eliminated that
behavior.

Train `model_turns` distributions:

| Model | Distribution | 12-turn ceiling | Forbidden-write tasks | Parse errors | Finished explicitly |
|---|---|---:|---:|---:|---:|
| Base | 4×14, 5×6, 6×3, 7×14, 8×2, 9×1, 12×8 | 8/48 | 0 | 0 | 40/48 |
| SFT epoch 4 | 3×33, 4×9, 5×2, 6×4 | 0/48 | 1 | 0 | 48/48 |
| GRPO step 20 | 3×35, 4×9, 5×4 | 0/48 | 0 | 0 | 48/48 |

Holdout `model_turns` distributions:

| Model | Distribution | 12-turn ceiling | Forbidden-write tasks | Parse errors | Finished explicitly |
|---|---|---:|---:|---:|---:|
| Base | 2×1, 4×3, 6×2, 7×3, 9×1, 10×1, 12×1 | 1/12 | 1 | 0 | 11/12 |
| SFT epoch 4 | 3×8, 4×1, 5×1, 6×1, 12×1 | 1/12 | 1 | 0 | 11/12 |
| GRPO step 20 | 3×9, 4×1, 5×2 | 0/12 | 0 | 0 | 12/12 |

The temperature-1.0 base variance probe also exposed a parsing failure. One
trajectory emitted seven malformed JSON actions containing JavaScript-style
expression fragments:

```text
{"tool":"api_fetch","arguments":{"method":"GET","url":"/crm/contacts/" + ("andrew.yao@example.test").split("@")[0]}}
```

That probe had 7 parse errors in total. The selected SFT and GRPO variance
probes had zero parse errors.

This differs from the prior lab finding where prompt-into-weights SFT on a
roughly 4B base collapsed into terminal-token repetition. Here, SFT learns
from in-context tool feedback and canonical action trajectories, while GRPO
uses terminal verifier reward. It is not prompt-into-weights training without
environment interaction.

### Group-variance progression

The same eight train tasks were sampled at temperature 1.0 with eight samples
per task:

| Arm | Mean reward | Nonzero-variance groups |
|---|---:|---:|
| Base | 0.734375 | 4/8 |
| SFT epoch 4 | 0.984375 | 1/8 |
| GRPO step 20 | 1.000000 | 0/8 |

For comparison, the Nemotron arm reported `8/8 → 2/8 → 1/8`.

## GRPO training curve

Mean group reward and constant-reward filtering fraction:

| Steps | Mean group reward | Constant-group fraction |
|---|---:|---:|
| 1–10 | 0.941406 | 0.800000 |
| 11–20 | 0.991406 | 0.912500 |
| 21–30 | 0.996875 | 0.975000 |
| 31–40 | 0.997396 | 0.975000 |

The complete per-step telemetry is in
`artifacts/grpo-stage2-telemetry.json`; the auditable bucket derivation is in
`artifacts/grpo-training-curve.json`. Dev reached `1.000000` at steps 20, 30,
and 40. The predeclared selection rule was highest DEV mean reward with an
earliest-tied-step tie-break, so step 20 was selected.

## Caveats

1. Dev and holdout contain only 12 tasks. A one-task change is approximately
   `0.083333` in the mean.
2. The fixture is synthetic and offline; this is not an upstream
   AutomationBench result.
3. This is one seed and one run per arm, with no error bars.
4. Dev saturated at `1.000000`, so selection among steps 20, 30, and 40 was a
   tie resolved only by the predeclared rule.
5. The holdout was run exactly once by the user and must not be rerun.

## Reproduction

These commands assume `/home/ubuntu/tinker-venv/bin/python` with Tinker and
`tinker-cookbook` installed. Provide `TINKER_API_KEY` only through the process
environment; never write it to an artifact.

Start the evaluator:

```bash
node scripts/automationbench-rl-service.mjs
```

Regenerate the train-only oracle data:

```bash
node scripts/automationbench-oracle-trajectories.mjs \
  --out experiments/qwen3-tinker-grpo/artifacts/oracle-train.jsonl
```

Baseline:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/evaluate.py \
  --split train --model-path base --label baseline-train \
  --temperature 0.0 --samples 1 \
  --out experiments/qwen3-tinker-grpo/artifacts/baseline-train.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/evaluate.py \
  --split dev --model-path base --label baseline-dev \
  --temperature 0.0 --samples 1 \
  --out experiments/qwen3-tinker-grpo/artifacts/baseline-dev.jsonl
```

SFT and GRPO:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/sft.py

/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/grpo.py \
  --stage 1 --max-steps 2

/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/grpo.py \
  --stage 2 --max-steps 40
```

The selected checkpoint is:

```text
tinker://d92128ce-3c0b-5473-b5ab-689dcad33c52:train:0/sampler_weights/000020
```

### Sealed holdout commands

The following three commands were run exactly once with the frozen hash,
after all model selection was final. They are recorded for provenance only
and **must not be rerun**:

```bash
/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/evaluate.py --split holdout --model-path base --label holdout-base --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/qwen3-tinker-grpo/artifacts/holdout-base.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/evaluate.py --split holdout --model-path tinker://9d8f6a98-d663-5627-8dd7-96571e243b4c:train:0/sampler_weights/sft-epoch4 --label holdout-sft-epoch4 --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/qwen3-tinker-grpo/artifacts/holdout-sft-epoch4.jsonl

/home/ubuntu/tinker-venv/bin/python experiments/qwen3-tinker-grpo/evaluate.py --split holdout --model-path tinker://d92128ce-3c0b-5473-b5ab-689dcad33c52:train:0/sampler_weights/000020 --label holdout-grpo-step20 --temperature 0.0 --samples 1 --frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 --out experiments/qwen3-tinker-grpo/artifacts/holdout-grpo-step20.jsonl
```

## Cost, receipts, and cleanup

Artifact-derived receipts are aggregated in
`artifacts/receipts-summary.json`. The grand total across the recorded
baseline, variance, SFT, GRPO, selected-checkpoint, and sealed-holdout phases
is:

```text
prompt tokens: 4,746,134
sampled tokens:   245,808
all tokens:     4,991,942
recorded wall clock: 914.6007 seconds
```

The recorded wall clock includes SFT and GRPO training/evaluation phases where
the harness persisted it. `evaluate.py` did not persist wall-clock fields in
its summary or usage receipts, so unavailable evaluation durations are
represented as `null`, not zero.

Every phase usage receipt reported an empty billing delta. One final Tinker
`get_billing_usage` query returned 28 usage events totaling 575,178 provider
tokens but no dollar amount. The artifact-derived totals above are therefore
the auditable cost proxy; no dollar figure was available.

Cleanup evidence is in `artifacts/cleanup-report.json`. The SFT run, GRPO
stage-1 run, and GRPO stage-2 run were queried; all 25 existing checkpoints
are retained as evidence with their provider-reported `expires_at` values.
No checkpoint was deleted.

No always-on serving or deployment resource exists for this arm: sampling
clients are ephemeral. Therefore there was no deployment to delete, and
deletion was confirmed as not applicable. If cleanup were requested, the
cleanup report lists every retained sampler and training checkpoint that
would be deleted. The local Node evaluator was stopped, and no matching
process or listening port remained.

All fixture tasks, contacts, observations, and trajectories are synthetic
offline test data; no customer or private trace data is included.
