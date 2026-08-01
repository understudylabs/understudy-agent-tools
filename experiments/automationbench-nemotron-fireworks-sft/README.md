# AutomationBench Nemotron Nano 3 Fireworks SFT

## Decision

**Negative result for the tuned arm.** Fireworks trained the LoRA adapter
successfully, but this account could not serve the tuned adapter in any
supported deployment shape. Therefore there is no tuned-train or tuned-dev
number, and no SFT effect can be claimed. The sealed holdout number below is
from the **base model**, not the tuned model; it influenced no choice because
there was no model selection to make.

All measurements used the repository's offline
`src/automationbench-offline.ts` evaluator: 72 synthetic `simple/api` tasks,
final-state `partialCredit`, train/dev/holdout splits of 48/12/12, and no
tool-name accuracy proxy. Results below are quoted from the gitignored
`outputs/` artifacts rather than committed.

## What was tested

The research question was whether a LoRA SFT update could make NVIDIA Nemotron
Nano 3 30B A3B reliably complete multi-step synthetic API workflows. The
training dataset contained oracle trajectories for the 48 train tasks only:
48 CHAT records, approximately 27,500 estimated tokens, train split only,
with an average of 7.895 turns per record. The SFT job used LoRA rank 16 and
three epochs.

Provider and base resource:

```text
provider: Fireworks
account: understudy-dev
model: accounts/fireworks/models/nemotron-nano-3-30b-a3b
supervisedLoraTunable: true
useHfApplyChatTemplate: true
supportsServerless: false
supportsLora: false
```

The exact arm order was:

1. Run the base model on train.
2. Run the base model on dev.
3. Build and submit the train-only SFT job.
4. Attempt to serve the resulting adapter, testing the available Fireworks
   deployment shapes and adapter/merge paths.
5. Because the tuned adapter was not servable, run the sealed holdout exactly
   once at the end with the base model and the frozen holdout hash.

All runs used temperature 0, `max_tokens=3000`, the `nemotron-text` protocol,
and concurrency 6–8.

## Tool protocol and native-tool-calling blocker

Native Fireworks tool calling was unavailable for this dedicated deployment.
The provider returned these errors verbatim:

```text
tool_choice:"auto" (and the default) → HTTP 400
"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

For `tool_choice:"required"` and a named function, the provider returned:

```text
requires --tool-call-parser to be set
```

Only `tool_choice:"none"` succeeded. `firectl` exposes no flag to enable the
vLLM tool-call parser.

Both measured arms therefore used the same workaround: send `tools` with
`tool_choice:"none"`, allow the HF chat template to render the tool surface,
and parse Nemotron's native text markup through
`nemotron-text-tools.mjs`:

```text
<tool_call>
<function=api_search>
<parameter=query>
record deal won CRM
</parameter>
</function>
</tool_call>
```

Because Fireworks trains with `useHfApplyChatTemplate:true`, structured
`tool_calls` in the SFT dataset render to this same markup. Training and
serving therefore used an identical protocol.

## Base-model results

### Baseline train

| Metric | Value |
| --- | ---: |
| Tasks | 48 |
| Mean score | 0.3333 |
| Single-write | 0.3125 |
| Discovery | 0.5625 |
| Multi-write | 0.125 |
| Model calls | 160 |
| Prompt tokens | 311,016 |
| Completion tokens | 87,755 |
| Mean latency | 3,897 ms |
| P95 latency | 7,419 ms |
| Wall time | 83.7 s |
| Errors | 0 |
| Tasks with malformed calls | 2 |
| Truncations | 29 |

The 29 truncations are 18% of baseline-train model calls, caused by Nemotron
reasoning before emitting a tool call and reaching the 3,000-token cap. The
multi-write band was the weakest at 0.125; discovery was substantially
stronger at 0.5625. Two tasks emitted a malformed tool call.
The recorded truncation counts (29 / 8 / 5) come from measured runs that
predate the per-request truncation-attribution fix, so they are approximate in
the aggregate rather than exact per-call.

### Baseline dev

| Metric | Value |
| --- | ---: |
| Tasks | 12 |
| Mean score | 0.3333 |
| Single-write | 0.5 |
| Discovery | 0.25 |
| Multi-write | 0.25 |
| Model calls | 33 |
| Prompt tokens | 57,146 |
| Completion tokens | 17,755 |
| Mean latency | 3,496 ms |
| P95 latency | 8,189 ms |
| Wall time | 29.9 s |
| Errors | 0 |
| Tasks with malformed calls | 0 |
| Truncations | 8 |

### Sealed holdout

The holdout was read exactly once, at the end, with the frozen hash passed
explicitly:

```text
a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

This is a **base-model** result, not a tuned-model result.

| Metric | Value |
| --- | ---: |
| Tasks | 12 |
| Mean score | 0.5833 |
| Single-write | 0.25 |
| Discovery | 1.0 |
| Multi-write | 0.5 |
| Model calls | 66 |
| Prompt tokens | 141,464 |
| Completion tokens | 29,255 |
| Mean latency | 3,048 ms |
| P95 latency | 7,224 ms |
| Wall time | 38.5 s |
| Errors | 0 |
| Tasks with malformed calls | 1 |
| Truncations | 5 |

Each dev/holdout task is worth 8.3 percentage points, so means on these
12-task slices are necessarily coarse.

## Training receipt

```text
dataset:
  accounts/understudy-dev/datasets/abo-nemotron-simpleapi-train-v1
records: 48 CHAT
estimated tokens: 27,500
average turns: 7.895
split: train only

job:
  accounts/understudy-dev/supervisedFineTuningJobs/abo-nemotron-sft-r16-v1
method: managed GA SFT
lora rank: 16
epochs: 3
state: JOB_STATE_COMPLETED
started: 21:24:42 UTC
finished: 21:33:42 UTC
duration: 9m00s
estimated cost: $0.359
trained tokens: approximately 82,500 (27,500 × 3)

checkpoint:
  accounts/understudy-dev/models/abo-nemotron-nano3-30b-sft-r16-v1
kind: HF_PEFT_ADDON
rank: 16
target modules: down_proj/in_proj/k_proj/o_proj/out_proj/q_proj/up_proj/v_proj
state: READY
```

## Tuned-serving blocker

The tuned adapter could not be served at all. Fireworks returned the following
evidence:

```text
multi-LoRA/addons → invalid deployment: addons are not supported for this model
```

This occurred on both H200 and B200 attempts. The base model has
`supportsLora:false`.

```text
firectl load-lora ... --deployment abo-nemotron-base-eval
→ deployment has addons disabled: set enable_addons=true on this deployment before loading LoRA adapters
```

That deployment shape could not enable addons for this model.

Deploying the PEFT model directly returned:

```text
live merge is not supported for this deployment configuration; choose a deployment shape that supports live merge, or use multi-lora (enable_addons=true) instead of live merge for LoRA fine-tuning
```

The same failure occurred on H200, H100, and B200. The only deployment shape
Fireworks suggested was:

```text
accounts/fireworks/deploymentShapes/rft-nemotron-nano-3-30b-a3b-grouped
```

That shape is 1x B200 BF16 but returned:

```text
PermissionDenied: the deployment shape version does not exist or you do not have access to it
```

`firectl` offers no server-side merge verb; `model create --base-model` only
registers a PEFT addon. An offline merge was outside the envelope on this VM:
31 GB RAM and 106 GB free disk versus approximately 63 GB of BF16 base weights,
another approximately 63 GB merged copy, and the re-upload.

**Conclusion:** Fireworks will train a LoRA for this base but currently offers
this account no way to serve one.

## Tinker portability

This is not Tinker-specific. Fireworks documents the adapter import path for
models where `Tunable:false` but `Supports Lora:true`. This base has the
inverse combination: `supervisedLoraTunable:true` and `supportsLora:false`.
Even the Fireworks-native r16 adapter, the best case for compatibility, could
not be hosted. An externally trained adapter for this base therefore has no
hosting path here either. This was an attempt, not a forced portability claim.

## Deployment and spend receipt

```text
deployment: accounts/understudy-dev/deployments/abo-nemotron-base-eval
hardware: 1x NVIDIA_H200_141GB
replicas: min=max=1
created: 21:23:57 UTC
deleted: 21:37 UTC
runtime: approximately 0.23 h
rate: approximately $7/GPU-hour
deployment cost: approximately $1.60
training cost: $0.359
total arm spend: approximately $1.96
budget: $200
```

The deployment was deleted at the end of the run and deletion was confirmed.

## Reproduction

Build the repository and generate the train dataset:

```bash
npm run build
node experiments/automationbench-nemotron-fireworks-sft/build-sft-dataset.mjs \
  outputs/automationbench-nemotron-train.jsonl
```

Run the offline gate:

```bash
node experiments/automationbench-nemotron-fireworks-sft/sanity.mjs
```

Run a model evaluation with the Nemotron text protocol:

```bash
node experiments/automationbench-nemotron-fireworks-sft/run-eval.mjs \
  --model accounts/fireworks/models/nemotron-nano-3-30b-a3b \
  --split train \
  --out outputs/baseline-train.json \
  --label baseline-train \
  --protocol nemotron-text \
  --concurrency 6 \
  --max-tokens 3000
```

Dev uses the same command with `--split dev`. Holdout must be explicitly
unsealed with the frozen hash; the evaluator refuses it otherwise:

```bash
node experiments/automationbench-nemotron-fireworks-sft/run-eval.mjs \
  --model accounts/fireworks/models/nemotron-nano-3-30b-a3b \
  --split holdout \
  --out outputs/baseline-holdout.json \
  --label baseline-holdout \
  --protocol nemotron-text \
  --concurrency 8 \
  --max-tokens 3000 \
  --frozen-holdout-sha256 \
  a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

`--protocol native` remains available for a provider deployment with native
tool-calling support. The measured Nemotron runs used `nemotron-text`.

Raw JSON artifacts and transcript JSONL files remain under `outputs/`, which
is gitignored. This note records the aggregate receipts and the provider
errors needed to interpret the result.
