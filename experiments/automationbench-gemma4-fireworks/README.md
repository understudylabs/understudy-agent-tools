# AutomationBench Gemma 4 Fireworks experiment

Status: baseline, oracle-SFT, tuned, and sealed holdout artifacts captured.
The sealed holdout was run exactly once on the dev-selected untuned base.

This experiment uses the repository's synthetic offline AutomationBench subset.
It contains no customer data and makes no claim about customer workloads.

## Protocol

The evaluation order is deliberately one-way:

1. Run the untuned Gemma 4 31B baseline on train and dev.
2. Build the SFT set from oracle trajectories on the 48 train tasks only.
3. Evaluate the tuned model on train and dev after its deployment is ready.
4. Evaluate the dev-selected model exactly once on the sealed holdout, passing
   the frozen holdout hash explicitly.

The authoritative environment and scorer are
[`src/automationbench-offline.ts`](../../src/automationbench-offline.ts):

- `reset()` / `step()` / `finish()` are the environment primitives;
- reward is terminal final-state partial credit from `partialCredit()`;
- writes outside the task's allowed paths force reward to zero;
- the metric is **not** tool-name accuracy or trajectory matching;
- the harness uses `parseToolCalls()` and the evaluator's own appended tool
  results as the source of truth.

The harness sanity gate ran on three train and three dev tasks:

| Policy | Mean reward |
| --- | ---: |
| Oracle | 1.0 |
| Sentinel | 0.0 |

## Frozen provenance

| Value | SHA-256 |
| --- | --- |
| Fixture / harness | `0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` |
| Train split | `783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89` |
| Dev split | `5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc` |
| Holdout split | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` |

The holdout hash is required on the command line. It is never defaulted or
hard-coded by the runner.

## Results

Scores are mean terminal final-state partial-credit rewards. Counts below are
task-level counts, not tool-call accuracy.

| Run | Model | Tasks | Mean reward | Errors | Malformed | Forbidden effects | Truncated |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline train | `accounts/fireworks/models/gemma-4-31b-it` | 48 | 0.8542 | 0 | 0 | 0 | 0 |
| Baseline dev | `accounts/fireworks/models/gemma-4-31b-it` | 12 | 0.8750 | 0 | 0 | 0 | 0 |
| Tuned train | `accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3` | 48 | 0.8472 | 0 | 0 | 0 | 0 |
| Tuned dev | `accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3` | 12 | 0.7917 | 0 | 0 | 0 | 0 |
| Sealed holdout (base) | `accounts/fireworks/models/gemma-4-31b-it` | 12 | 0.8750 | 0 | 0 | 0 | 0 |

Baseline details:

- dedicated 4xB200 deployment;
- train prompt tokens: 86,567;
- train completion tokens: 6,057;
- train wall time: 92,557 ms;
- dev prompt tokens: 19,637;
- dev completion tokens: 1,431;
- dev wall time: 16,813 ms;
- one train task reached the evaluator's 12-step limit; this is separate from
  the zero truncation count.

Tuned details:

- dedicated deployment whose `baseModel` was the tuned LoRA model;
- train prompt tokens: 86,260;
- train completion tokens: 5,849;
- train wall time: 103,200 ms;
- dev prompt tokens: 27,383;
- dev completion tokens: 1,700;
- dev wall time: 24,019 ms;
- one train task and one dev task reached the evaluator's 12-step limit;
- malformed calls, forbidden effects, and truncations were all zero.

Sealed holdout details:

- exactly one run, after model selection;
- selected untuned base model: `accounts/fireworks/models/gemma-4-31b-it`;
- prompt tokens: 20,951;
- completion tokens: 1,457;
- wall time: 28,560 ms;
- zero step-limit terminations, malformed calls, forbidden effects, and
  truncations.

SFT details:

- Fireworks job: `ab-gemma4-31b-sft-r16-e3`;
- output model: `accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3`;
- LoRA rank: 16;
- epochs: 3;
- dataset: 48 records / provider-reported 26,800 dataset tokens (local
  estimate: 26,307);
- three epochs over that dataset billed 69,630 training tokens;
- training cost: $0.209;

## Model selection

The selection rule is **dev-only**: choose the model with the higher mean
terminal final-state reward on the frozen 12-task dev split, then seal the
holdout evaluation using that selected model. Train results are diagnostic and
do not select the model.

The untuned base scored **0.8750** on dev. The oracle-trajectory SFT model
scored **0.7917** on dev. Therefore the selected final model for the sealed
holdout is the untuned base:

```text
accounts/fireworks/models/gemma-4-31b-it
```

The sealed holdout was therefore run exactly once, at the very end, on the
untuned base. It was not used to revise this selection decision.

## Interpretation

On this synthetic fixture, the untuned instruct model is already strong:
baseline dev reward is 0.8750. The SFT arm used only 48 oracle trajectories
(approximately 26.8k provider-reported dataset tokens), with rank-16 LoRA for
three epochs. It slightly degraded both train reward (0.8542 to 0.8472) and
dev reward (0.8750 to 0.7917).

This is consistent with the known failure mode for behavior-cloning a small
oracle set onto an already-competent instruct model: the arm buys no measured
improvement here and can cost a little. This result is narrow and should not
be overclaimed. The dev split has only 12 tasks, so the 0.0833 reward gap is
roughly one task's worth of aggregate partial credit; it is evidence against
this particular SFT arm on this fixture, not a general statement that LoRA or
SFT cannot help.

## Receipts

The authoritative cost source was the Fireworks `billingUsage` API, not a
local estimate:

- SFT job: `ab-gemma4-31b-sft-r16-e3`;
- output model: `accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3`;
- LoRA rank: 16;
- epochs: 3;
- billed training tokens: 69,630;
- SFT training cost: **$0.2089** (the job also reported
  `estimatedCost=0.208890006` USD);
- base evaluation deployment:
  `accounts/understudy-dev/deployments/ab-gemma4-31b-eval` — 2,284
  accelerator-seconds;
- tuned evaluation deployment:
  `accounts/understudy-dev/deployments/ab-gemma4-31b-tuned-eval` — 392
  accelerator-seconds;
- sealed holdout deployment:
  `accounts/understudy-dev/deployments/ab-gemma4-31b-holdout` — 208
  accelerator-seconds;
- serving total: 2,884 accelerator-seconds, **$8.01** at $10/GPU-hour;
- total arm cost: **$8.22** ($0.2089 training + $8.01 serving) against the
  **$150** budget.

All three experiment deployments report `DELETED`, and no
`ab-gemma4-31b-*` deployment or deployed model remains in the account. One
unrelated `ab-gemma4-26ba4b-*` deployed model was left untouched.

### Latency and token receipts

These values are copied from the run summary sidecars:

| Run | Wall time (ms) | Prompt tokens | Completion tokens |
| --- | ---: | ---: | ---: |
| Baseline train | 92,557 | 86,567 | 6,057 |
| Baseline dev | 16,813 | 19,637 | 1,431 |
| Tuned train | 103,200 | 86,260 | 5,849 |
| Tuned dev | 24,019 | 27,383 | 1,700 |
| Sealed holdout (base) | 28,560 | 20,951 | 1,457 |

### Serving-path verification

`replaceMergedAddon=true` reported state `DEPLOYED`, but the endpoint kept
answering with `model=accounts/fireworks/models/gemma-4-31b-it`: a silent
no-op. The only confirmed tuned-serving path was the dedicated tuned
deployment, whose response echoed
`model=accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3`.

Always verify the echoed `model` field before trusting a tuned-serving path.

## Reproduction commands

Run from the repository root. Node 22.19+ is the repository target runtime.
The commands below assume `FIREWORKS_API_KEY` is already present in the
environment. The harness default base URL,
`https://api.fireworks.ai/inference`, was used; no `--base-url` override was
passed.

The `--model` argument below is the **deployment resource ID**, not the bare
model ID. Passing `accounts/fireworks/models/gemma-4-31b-it` to a dedicated
deployment returns `Model not found, inaccessible, and/or not deployed`.

### Create the dedicated deployments

Create each deployment with these settings before its scored run:

| Deployment resource | Purpose | Base model | Accelerator | Min replicas | Addons |
| --- | --- | --- | --- | ---: | --- |
| `accounts/understudy-dev/deployments/ab-gemma4-31b-eval` | Baseline train + dev | `accounts/fireworks/models/gemma-4-31b-it` | 4 × `NVIDIA_B200_180GB` | 1 | `enableAddons: true` |
| `accounts/understudy-dev/deployments/ab-gemma4-31b-tuned-eval` | Tuned train + dev | `accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3` | 4 × `NVIDIA_B200_180GB` | 1 | — |
| `accounts/understudy-dev/deployments/ab-gemma4-31b-holdout` | Sealed holdout | `accounts/fireworks/models/gemma-4-31b-it` | 4 × `NVIDIA_B200_180GB` | 1 | — |

The baseline deployment's `enableAddons: true` setting was retained from
creation, although it did not matter because the attempted addon-loading path
failed. The deployment resource IDs are what the harness received in
`--model`.

### Build and local sanity

```sh
npm run build
node scripts/automationbench-gemma-harness.mjs --sanity
```

### Build the train-only oracle SFT set

```sh
node scripts/automationbench-gemma-sft-dataset.mjs \
  --output experiments/automationbench-gemma4-fireworks/artifacts/sft-train.jsonl
```

This writes the JSONL and its
`sft-train.jsonl.manifest.json` provenance sidecar. The sidecar records all 48
train task IDs, the fixture hash, the train split hash, record count, and token
estimate.

### Baseline train and dev

```sh
node scripts/automationbench-gemma-harness.mjs \
  --split train \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-eval \
  --concurrency 8 \
  --max-tokens 768 \
  --timeout-ms 120000 \
  --run-id baseline-gemma4-31b-train \
  --output experiments/automationbench-gemma4-fireworks/artifacts/baseline-train.jsonl

node scripts/automationbench-gemma-harness.mjs \
  --split dev \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-eval \
  --concurrency 8 \
  --max-tokens 768 \
  --timeout-ms 120000 \
  --run-id baseline-gemma4-31b-dev \
  --output experiments/automationbench-gemma4-fireworks/artifacts/baseline-dev.jsonl
```

Each run writes its `<output>.summary.json` sidecar.

### Tuned train and dev

Use the dedicated deployment whose `baseModel` is the tuned LoRA model:

```sh
node scripts/automationbench-gemma-harness.mjs \
  --split train \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-tuned-eval \
  --concurrency 8 \
  --max-tokens 768 \
  --timeout-ms 120000 \
  --run-id tuned-gemma4-31b-sft-r16-train \
  --output experiments/automationbench-gemma4-fireworks/artifacts/tuned/tuned-train.jsonl

node scripts/automationbench-gemma-harness.mjs \
  --split dev \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-tuned-eval \
  --concurrency 8 \
  --max-tokens 768 \
  --timeout-ms 120000 \
  --run-id tuned-gemma4-31b-sft-r16-dev \
  --output experiments/automationbench-gemma4-fireworks/artifacts/tuned/tuned-dev.jsonl
```

The harness also supports an unscored `--dry-run` request inspection mode and
an `--extra-body '<json>'` request-body extension. Neither was used in a
scored run; they are available for future request inspection or provider
controls.

```sh
node scripts/automationbench-gemma-harness.mjs \
  --dry-run \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-tuned-eval
```

### Single sealed holdout

Do not run this until model selection is recorded and the fresh base
deployment is confirmed:

```sh
node scripts/automationbench-gemma-harness.mjs \
  --split holdout \
  --frozen-holdout-sha256 \
  a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701 \
  --model accounts/understudy-dev/deployments/ab-gemma4-31b-holdout \
  --concurrency 8 \
  --max-tokens 768 \
  --timeout-ms 120000 \
  --run-id sealed-holdout-gemma4-31b-base \
  --output experiments/automationbench-gemma4-fireworks/artifacts/holdout/base-holdout.jsonl
```

## Fireworks portability and serving lessons

These facts are part of the experiment record:

- `gemma-4-31b-it` is not serverless on Fireworks. It requires a dedicated
  deployment with a minimum of four accelerators; H100 deployments require
  eight.
- The account's B200 and H200 quotas were 16 accelerators each, fully consumed
  by pre-existing deployments. Consequently, only one 4xB200 evaluation
  deployment could exist at a time, so base and tuned evaluations had to run
  sequentially.
- Loading the tuned LoRA as a PEFT addon onto a base
  `gemma-4-31b-it` deployment failed with:

  ```text
  Unsupported LoRA parameter: model.language_model.layers.0.mlp.down_proj.lora_A.weight
  ```

  The failure is caused by Gemma 4 multimodal-prefixed parameter names.
- `replaceMergedAddon=true` reported `DEPLOYED`, but the endpoint still
  answered with `model=accounts/fireworks/models/gemma-4-31b-it`; this was a
  silent no-op. Always verify the echoed response `model` field.
- The working serving pattern is a dedicated deployment whose `baseModel` is
  the tuned LoRA model itself. That deployment echoed
  `model=accounts/understudy-dev/models/ab-gemma4-31b-oracle-sft-r16-e3`.

## Artifact layout

```text
artifacts/
  baseline-train.jsonl
  baseline-train.jsonl.summary.json
  baseline-dev.jsonl
  baseline-dev.jsonl.summary.json
  sft-train.jsonl
  sft-train.jsonl.manifest.json
  tuned/
    tuned-train.jsonl
    tuned-train.jsonl.summary.json
    tuned-dev.jsonl
    tuned-dev.jsonl.summary.json
  holdout/
    base-holdout.jsonl
    base-holdout.jsonl.summary.json
```

The raw SFT JSONL is included because it is approximately 105 KB and keeps the
experiment reproducible without being an outsized repository artifact. The
tuned artifacts are now populated with the negative-result train/dev runs. The
sealed holdout artifacts are the single final base run; no additional
holdout run was fabricated.
