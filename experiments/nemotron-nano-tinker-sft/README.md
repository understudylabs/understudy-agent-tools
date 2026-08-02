# Nemotron-3-Nano AutomationBench offline lab note

This is a deterministic, synthetic-data-only evaluation and SFT harness for
`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` through Tinker. The evaluator is
the built `dist/automationbench-offline.js` module, reached through
`env-daemon.mjs`; scoring is terminal final-state reward, not tool-name
accuracy.

## Protocol

The lifecycle was:

1. Build and sanity-gate the evaluator.
2. Build 48 train-only oracle SFT trajectories.
3. Repair an invalid 700-token smoke cap; use `max_tokens=4096` for the
   published baseline and later evaluations.
4. Evaluate the untuned base on all 48 train and 12 dev tasks.
5. Train assistant-only LoRA SFT from the base, rank 16, for 3 epochs over
   train-only oracle datums. Save a sampler after each epoch.
6. Select solely on dev mean reward among the three epoch checkpoints.
7. Evaluate the selected checkpoint on train for a tuned-train receipt.
8. Run exactly one sealed holdout event, evaluating both base and selected
   checkpoint with the frozen holdout hash.

All model calls use the Tinker renderer/sampling path. Tinker’s
OpenAI-compatible `tools=` path is not used because it raises
`NotImplementedError`. The driver samples at temperature `0.0`, uses the
renderer stop sequences, parses renderer tool calls, and runs the same
environment daemon for every split.

The holdout event passed:

```text
a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

The holdout runner checkpoints after every task and refuses to start over an
existing artifact unless `--resume` is explicitly supplied. The sealed artifact
was completed in one event; no holdout result was used to change selection or
the harness.

## Training receipt

| Field | Value |
|---|---|
| Provider | Tinker |
| Base model | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| LoRA rank | 16 |
| Epochs | 3 |
| Optimizer steps | 36 |
| Batch size | 4 |
| Initial learning rate | `5e-5` |
| Schedule | Linear decay to zero |
| Train tokens/epoch | 38,914 |
| Total train tokens | 116,742 |
| Training wall time | 136.159s |

Loss was finite and decreased from `0.318343` to `0.104473`; the minimum
observed batch loss was `0.005227`. The renderer emitted its known warning
that `ALL_ASSISTANT_MESSAGES` is used with `has_extension_property=False`.
The training data still contained the evaluator-owned tools block.

Epoch sampler checkpoints:

```text
tinker://14b6d378-24d1-5061-9116-1ec78c1ca7a3:train:0/sampler_weights/nemotron-nano-sft-epoch-1
tinker://14b6d378-24d1-5061-9116-1ec78c1ca7a3:train:0/sampler_weights/nemotron-nano-sft-epoch-2
tinker://14b6d378-24d1-5061-9116-1ec78c1ca7a3:train:0/sampler_weights/nemotron-nano-sft-epoch-3
```

The selected winner is the epoch-3 sampler. No dedicated deployment was
created.

## Results

### Baseline and selected checkpoint

| Run | Split | Mean reward | Truncated | Malformed | No-tool | Forbidden | Step-limit | Mean output tokens/task | Mean latency/task |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Base | train (48) | 0.802083 | 5 | 0 | 0 | 0 | 4 | 4,417.94 | 135.836s |
| Base | dev (12) | 0.916667 | 0 | 0 | 0 | 0 | 1 | 5,191.50 | 179.368s |
| Tuned epoch 3 | train (48) | 0.899306 | 1 | 1 | 0 | 0 | 4 | 2,756.31 | 98.466s |
| Tuned epoch 3 | dev (12) | 0.888889 | 0 | 0 | 0 | 0 | 1 | 3,008.00 | 137.213s |

The train improvement is on the SFT training task family and is consistent
with memorization; it is not evidence of generalization. Dev reward did not
improve. The dev gap is only about 0.028 on 12 examples and is
noise-dominated, but the direction is still neutral-to-negative for reward.

The robust win is efficiency: selected-checkpoint output tokens fell 37.6%
on train and 42.1% on dev; latency fell 27.5% on train and 23.5% on dev.

### Dev-only checkpoint selection

Selection rule: highest dev mean reward; ties broken by fewer failure modes,
then fewer output tokens.

| Checkpoint | Mean reward | Truncated | Malformed | No-tool | Forbidden | Step-limit | Output tokens | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Epoch 1 | 0.805556 | 2 | 0 | 0 | 0 | 1 | 43,435 | 1,839.021s |
| Epoch 2 | 0.791667 | 0 | 0 | 0 | 0 | 4 | 37,580 | 1,763.335s |
| **Epoch 3 (winner)** | **0.888889** | **0** | **0** | **0** | **0** | **1** | **36,096** | **1,646.557s** |

### Sealed holdout final

The base and winner were evaluated exactly once each on the 12 holdout tasks.

| Run | Mean reward | Truncated | Malformed | No-tool | Forbidden | Step-limit | Output tokens | Wall time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Base | **0.875000** | 0 | 0 | 0 | 0 | 2 | 56,337 | 1,908.549s |
| Winner epoch 3 | **0.916667** | 0 | 0 | 0 | 0 | 1 | 29,516 | 948.144s |

The winner beats base by `0.0417` on `n=12` (about half a task), which is
inside noise and is **not** a claim of generalized quality improvement. The
defensible holdout result is the efficiency improvement: 47.6% fewer output
tokens, 50.3% less wall time, and no new failure modes. This holdout result is
descriptive only. It was not used for selection, prompt changes, retraining,
or reruns.

## Artifacts

The artifacts directory is approximately **980 KB** and contains:

```text
baseline-dev.json
baseline-train.json
cleanup-evidence.json
dataset-stats.json
epoch-1-dev.json
epoch-2-dev.json
epoch-3-dev.json
holdout-sealed.json
oracle-train-datums.jsonl
oracle-train.jsonl
rendered-prompt.txt
rendered-roundtrip-turn-2.txt
sample-transcripts.json
selection-receipt.json
smoke-3072.json
training-receipt.json
tuned-train.json
```

The JSON/JSONL files contain per-task rows, summaries, token counts,
latencies, checkpoint URIs, and the frozen holdout hash. Verbose per-task
transcript arrays were pruned from scored run files without changing any row
or summary values. `sample-transcripts.json` retains two representative
transcripts for each retained run (baseline dev, tuned train, and both sealed
holdout models). A value-based scan of 22 experiment files found no
provisioned secret values.

The cleanup query and its exact output are recorded in
`artifacts/cleanup-evidence.json`. It found the expected training run and no
matching sessions. No dedicated deployment was created; Tinker 0.24 exposes
no deployment list/delete resource in its REST client, and this harness only
created sampling clients and sampler checkpoints.

## Portability and failure notes

- Python runtime: `>=3.11`; this run used the provisioned Python 3.12 Tinker
  environment.
- The repository declares Node `>=22.19.0`, but this VM has Node 20.
  `npm run build`, `npm run typecheck`, and the focused evaluator test pass;
  full `npm test` remains blocked by the VM’s `node:sqlite` limitation.
- The initial 700-token smoke cap caused false baseline zeros: all three
  tasks were truncated before their first tool call. The cap was made a CLI
  flag, the smoke was rerun at 3072, and the default became 4096.
- Nemotron emits long `<think>` blocks. The renderer stop sequences were
  verified and prompt/assistant-tool/tool-response round-trip dumps are
  included.
- The renderer warns that its extension property is false when using
  `ALL_ASSISTANT_MESSAGES`; this is a known training-path caveat.
- The selected model still sometimes repeats exploratory searches and had one
  malformed train call and four train step-limit failures. No forbidden
  effects occurred.

## Reproduction commands

```bash
npm run build
npm run typecheck
node --test tests/automationbench-offline.test.mjs

PATH=/home/ubuntu/.venv-tinker/bin:$PATH \
python experiments/nemotron-nano-tinker-sft/build_dataset.py

PATH=/home/ubuntu/.venv-tinker/bin:$PATH \
python experiments/nemotron-nano-tinker-sft/driver.py \
  --split train --tasks 48 --max-tokens 4096 \
  --output experiments/nemotron-nano-tinker-sft/artifacts/baseline-train.json

PATH=/home/ubuntu/.venv-tinker/bin:$PATH \
python experiments/nemotron-nano-tinker-sft/driver.py \
  --split dev --tasks 12 --max-tokens 4096 \
  --output experiments/nemotron-nano-tinker-sft/artifacts/baseline-dev.json
```

Do not rerun the sealed holdout command: its single scored event is complete.

## Total observed usage

Across all four handoffs, known usage was **3,946,975 tokens** and
**21,906.063 seconds (6.09 hours)** of measured wall time. This includes the
discarded preliminary SFT attempt and the one sealed holdout event. The
preliminary failed attempt's partial wall time was not recorded.

No invoice was exposed by the Tinker client. At a conservative sensitivity of
$5 per million tokens, the known token volume corresponds to approximately
**$19.74**, well below the $150 arm budget. This is a sensitivity estimate,
not a provider invoice.
