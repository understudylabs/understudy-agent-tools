# GEPA vs GRPO AutomationBench stack

This directory contains the evaluation-only harness and artifacts for the
offline AutomationBench comparison described in [`LAB-NOTE.md`](LAB-NOTE.md).
The harness uses the Tinker sampling API with the local AutomationBench
service. It does not create training jobs, deployments, or serving resources.

## Environment

```text
Python: 3.11
venv:   /home/ubuntu/tinker-venv
tinker: 0.23.1
tinker-cookbook: 0.5.2
Node:   20.18.1
```

The Tinker client needs the system-CA transport workaround already present in
the Python runners. Do not print or persist provider keys.

```sh
cd /home/ubuntu/repos/understudy-agent-tools
source /home/ubuntu/tinker-venv/bin/activate
npm run build
python -m py_compile experiments/gepa-vs-grpo-stack/*.py
```

## Frozen benchmark

```text
benchmark:       automationbench-simple-api-offline
fixture:         automationbench-simple-api-offline-v1
TRAIN:           48 tasks
DEV:             12 tasks
HOLDOUT:         12 tasks
split seed:      7
```

Hashes are recorded in every evaluation summary:

```text
fixture: 0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f
train:   783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89
dev:     5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc
holdout: a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

## Sanity gate

Run the service-level oracle/sentinel gate:

```sh
node scripts/automationbench-sanity-gate.mjs \
  > experiments/gepa-vs-grpo-stack/artifacts/sanity-gate.json
```

The gate artifact records oracle reward `1`, sentinel reward `0`, and the
sentinel forbidden write `crm.contacts.c-0` for both
`simple-api-crm-close-01` (single-write) and
`simple-api-crm-bulk-owner-01` (multi-write).

Generate the oracle trajectories used by the evaluator:

```sh
node scripts/automationbench-oracle-trajectories.mjs \
  --out experiments/gepa-vs-grpo-stack/artifacts/oracle-trajectories.jsonl
```

The recorded two-task smoke evaluation is:

```sh
python experiments/gepa-vs-grpo-stack/evaluate.py \
  --split train \
  --model-path base \
  --label smoke-base-baseline \
  --temperature 0 \
  --samples 1 \
  --limit 2 \
  --concurrency 2 \
  --max-model-turns 12 \
  --no-usage-receipt \
  --out experiments/gepa-vs-grpo-stack/artifacts/smoke-base-baseline.jsonl
```

The checked result is in `artifacts/smoke-base-baseline.summary.json`.

## Models and baseline cells

```sh
export GRPO_PATH='tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020'
```

Base TRAIN:

```sh
python evaluate.py \
  --split train --model-path base --label cell-a-base-baseline-train \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/cell-a-base-baseline-train.jsonl
```

Base DEV:

```sh
python evaluate.py \
  --split dev --model-path base --label cell-a-base-baseline-dev \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/cell-a-base-baseline-dev.jsonl
```

GRPO TRAIN:

```sh
python evaluate.py \
  --split train --model-path "$GRPO_PATH" --label cell-c-grpo-baseline-train \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/cell-c-grpo-baseline-train.jsonl
```

GRPO DEV:

```sh
python evaluate.py \
  --split dev --model-path "$GRPO_PATH" --label cell-c-grpo-baseline-dev \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/cell-c-grpo-baseline-dev.jsonl
```

The runner currently leaves Tinker’s `seed` unset. `temperature=0` is not
deterministic on this path. Future comparisons should add and record an
explicit `SamplingParams.seed`.

## GEPA variants

All variants are TRAIN-only for proposal/acceptance and DEV-only for final
selection. They use seed 7 and eight iterations by default. Each script writes
its own distinct `gepa-*` artifact names.

Original minibatch-gated v1:

```sh
python gepa_optimize.py \
  --iterations 8 --seed 7 --concurrency 8 \
  --reflection-model claude-sonnet-4-6
```

v2: failure-driven minibatches and full-TRAIN acceptance:

```sh
python gepa_optimize_v2.py \
  --iterations 8 --seed 7 --concurrency 8 \
  --reflection-model claude-sonnet-4-6
```

v3: v2 plus real public endpoint catalog and observed responses:

```sh
python gepa_optimize_v3.py \
  --iterations 8 --seed 7 --concurrency 8 \
  --reflection-model claude-sonnet-4-6
```

v4 conservative suffix mode:

```sh
python gepa_optimize_v4.py \
  --iterations 8 --seed 7 --concurrency 8 \
  --reflection-model claude-sonnet-4-6
```

v4 full-system-prompt rewrite mode:

```sh
python gepa_optimize_v4.py \
  --iterations 8 --seed 7 --concurrency 8 \
  --reflection-model claude-sonnet-4-6 \
  --full-rewrite
```

Do not use any holdout rows during these commands.

## Prompt files and reported cells

The frozen baseline prompt is:

```text
artifacts/baseline-action-protocol-prompt.txt
```

The sibling transfer source and adapted prompt are:

```text
artifacts/transfer-gepa-prompt-source.txt
artifacts/transfer-gepa-prompt.txt
```

Run the four-task transfer parse probe before full transfer evaluation:

```sh
python evaluate.py \
  --split train --model-path base --label transfer-probe-base \
  --temperature 0 --samples 1 --limit 4 --concurrency 4 \
  --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/transfer-probe-base-train.jsonl
```

Transfer TRAIN/DEV:

```sh
python evaluate.py \
  --split train --model-path base --label transfer-base-train \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/transfer-base-train.jsonl

python evaluate.py \
  --split dev --model-path base --label transfer-base-dev \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/transfer-base-dev.jsonl

python evaluate.py \
  --split train --model-path "$GRPO_PATH" --label transfer-grpo-train \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/transfer-grpo-train.jsonl

python evaluate.py \
  --split dev --model-path "$GRPO_PATH" --label transfer-grpo-dev \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/transfer-grpo-dev.jsonl
```

## Sealed holdout

Holdout must be declared before access. The completed declaration is:

```text
artifacts/sealed-holdout-manifest.json
```

It authorizes exactly four calls, once each:

1. Base + empty
2. GRPO + empty
3. Base + transfer prompt
4. GRPO + transfer prompt

The frozen hash is mandatory:

```sh
export HOLDOUT_SHA='a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701'
```

The exact completed commands were:

```sh
python evaluate.py \
  --split holdout --frozen-holdout-sha256 "$HOLDOUT_SHA" \
  --model-path base --label sealed-base-empty \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/sealed-base-empty-holdout.jsonl

python evaluate.py \
  --split holdout --frozen-holdout-sha256 "$HOLDOUT_SHA" \
  --model-path "$GRPO_PATH" --label sealed-grpo-empty \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/sealed-grpo-empty-holdout.jsonl

python evaluate.py \
  --split holdout --frozen-holdout-sha256 "$HOLDOUT_SHA" \
  --model-path base --label sealed-base-transfer \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/sealed-base-transfer-holdout.jsonl

python evaluate.py \
  --split holdout --frozen-holdout-sha256 "$HOLDOUT_SHA" \
  --model-path "$GRPO_PATH" --label sealed-grpo-transfer \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --system-prompt-file artifacts/transfer-gepa-prompt.txt \
  --no-usage-receipt --out artifacts/sealed-grpo-transfer-holdout.jsonl
```

These four commands have already been run once. Do not rerun them, retune from
their outcomes, or use the holdout for prompt selection.

## Noise-band repeats

The committed/evidence package includes three repeats for each empty-prompt
model/split cell. The repeat commands are the baseline commands above with
distinct labels and output paths, for example:

```sh
python evaluate.py \
  --split train --model-path base --label noise-base-train-2 \
  --temperature 0 --samples 1 --concurrency 8 --max-model-turns 12 \
  --no-usage-receipt --out artifacts/noise-base-train-2.jsonl
```

See `artifacts/noise-band-summary.json` for the complete artifact-to-cell
mapping and disagreement counts.

## Verification

```sh
npm run build
/home/ubuntu/tinker-venv/bin/python -m py_compile experiments/gepa-vs-grpo-stack/*.py
git diff --check
```

The lab note is the evidence-led interpretation; raw JSONL files retain the
per-task trajectories, sampled token counts, prompt token counts, hashes, and
failure fields.
