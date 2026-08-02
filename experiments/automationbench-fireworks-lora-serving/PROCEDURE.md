# Fireworks LoRA serving procedure

Scope: the synthetic `automationbench-simple-api-offline` fixture, using the
OpenAI-compatible Chat Completions runner in this directory. Keep base and
tuned comparisons on the same protocol, token budget, split, and harness.

## Adapter capability gate

Fireworks LoRA `target_modules` allowlist:

```text
q_proj, k_proj, v_proj, o_proj
up_proj/w1, down_proj/w2, gate_proj/w3
block_sparse_moe.gate
lm_head (Llama/Mistral/Qwen2/Qwen2-VL/Kimi K2.5 only)
```

Embedding modules are unsupported. Check the adapter target modules before
creating a deployment:

| Adapter | Base | Actual target modules | Multi-LoRA / `--enable-addons` | Live merge |
|---|---|---|---|---|
| `abo-nemotron-nano3-30b-sft-r16-v1` | `nemotron-nano-3-30b-a3b` | `down_proj, in_proj, k_proj, o_proj, out_proj, q_proj, up_proj, v_proj` | **No**: base `supportsLora=False`, `tunable=False`; addon reports `supportsLora=False` and our addon load was rejected | **No verified path**: live-merge attempt rejected and grouped RFT shape returned `PermissionDenied` |
| `ab-gemma4-26ba4b-oracle-sft-r16-e3` | `gemma-4-26b-a4b` | `base_layer, down_proj, experts, gate_proj, k_proj, o_proj, q_proj, up_proj, v_proj` | **No**: three independent addon deployments showed control-plane `DEPLOYED` but inference 404 | **Yes**: real completions verified on a 4xB200 live-merge RFT shape |
| `ab-gemma4-31b-oracle-sft-r16-e3` | `gemma-4-31b` | `down_proj, gate_proj, k_proj, o_proj, q_proj, up_proj, v_proj` | **Yes in principle**: targets are supported; not tested because quota blocked the required 4-GPU shape | **Yes in principle**: targets are supported; not tested because quota blocked the required 4-GPU shape |
| `qwen3-8b-abo-simpleapi-sft-r16e3` | `qwen3-8b` | supported dense projection modules | **Not usable in this run**: two BF16 addon deployments entered `FAILED` with internal errors | **Yes**: measured base/tuned pair |

The allowlist constrains the runtime multi-LoRA path. Our inference is that
live merge bakes the adapter into the weights ahead of time, so unsupported
runtime modules stop mattering there; this is an explanation that fits the
observations, not a Fireworks-documented guarantee.

## Working path: live merge (recommended for one adapter)

Live merge supports native tool calls and requires no addon flags. It is the
only serving path verified for the Gemma-26B-A4B MoE adapter; that path used a
4xB200 RFT shape and costs approximately $60/hour, so this experiment did not
create one:

```bash
firectl create deployment accounts/<acct>/models/<TUNED_MODEL_ID> \
  --accelerator-type NVIDIA_H200_141GB \
  --accelerator-count 1 \
  --min-replica-count 1 \
  --max-replica-count 1 \
  --deployment-id <ID>
```

Address the tuned model with the deployment suffix:

```text
accounts/<acct>/models/<TUNED_MODEL_ID>#accounts/<acct>/deployments/<ID>
```

The plain model ID without `#deployment` is not a valid LoRA inference route.

## Working path: multi-LoRA/addon hotload

Use this only when multiple adapters must share one GPU:

```bash
firectl create deployment accounts/fireworks/models/<BASE> \
  --enable-addons \
  --precision BF16 \
  --disable-speculative-decoding \
  --accelerator-type NVIDIA_H200_141GB \
  --accelerator-count 1 \
  ...

firectl model load-lora <TUNED_MODEL_ID> \
  --deployment <ID> \
  --wait \
  --wait-timeout 14m
```

Addon requirements and limitations:

- `--precision BF16` and `--disable-speculative-decoding` are both required
  when the default model shape is FP8/FP4.
- Native tool calling was rejected on the addon deployment we tested (see
  below). Not verified across bases: treat as a risk to check, not a law.
- Use `--validate-only` as a free shape pre-check.
- Adapter loading takes approximately 10–11 minutes.
- The `#deployment` suffix is mandatory for LoRA inference.

## Provider errors and operational traps

Record these verbatim; they identify distinct failure modes:

```text
addons are not supported for this model
```

```text
live merge is not supported for this deployment configuration; choose a deployment shape that supports live merge, or use multi-lora (enable_addons=true) instead of live merge for LoRA fine-tuning
```

Gemma-26B-A4B adapter inference returned this on three independent
deployments (1xH200 default precision, 1xH200 BF16 with no speculative
decoding, and 2xH100):

```text
{"error":{"message":"The model \`accounts/understudy-dev/models/ab-gemma4-26ba4b-oracle-sft-r16-e3#accounts/understudy-dev/deployments/abo-g26-bf16-lora\` does not exist.","type":"NotFoundError","param":"model","code":404}}
```

`firectl model load-lora` can report success and the control plane can show
`State: DEPLOYED / Default: true`, while inference still returns the 404
above. For the Gemma-26B-A4B adapter, this is a multi-LoRA limitation, not a
general adapter limitation: live merge served real completions. Treat this
silent-success-then-404 pattern as an addon capability or serving-path
failure, not proof that live merge is impossible.

```text
draft model precision validation failed: addons cannot be enabled with quantized precisions (FP8/FP4)
```

```text
invalid deployment: addons cannot be enabled with quantized precisions (FP8/FP4)
```

```text
"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

`firectl create deployment` exposes no flags for either of the two required
native-tool settings, so this could not be configured away.

Evidence boundary: this error was observed on a `gemma-4-26b-a4b-it` **addon**
deployment, while native tool calls worked with no extra flags on a `qwen3-8b`
**live-merge** deployment. Deployment type and base model are confounded — we
never had a working addon deployment to test in isolation. Prefer live merge
when native tool calls are required, and verify before assuming the cause.

```text
Internal error occurred, please contact the Fireworks AI team at https://discord.gg/fireworks-ai
```

This occurred twice for a Qwen3-8B BF16 `--enable-addons` deployment; both
deployments entered `state FAILED`.

Nemotron is dropped after three independent capability signals: the base
reports `supportsLora=False` and `tunable=False`, the addon reports
`supportsLora=False`, and our addon, live-merge, and grouped-RFT attempts were
rejected (`addons are not supported for this model`, the live-merge
configuration error above, and `PermissionDenied` respectively).

```text
deployment has received inference requests in the last hour, pass --ignore-checks to skip this check
```

```text
global--h200-count for account understudy-dev, in use: 14, quota: 16, requesting: 4
```

```text
Extra inputs are not permitted, field: 'chat_template_kwargs'
```

Fireworks rejects `chat_template_kwargs`; do not use it to disable Qwen3
thinking. Budget approximately 2000 `max_tokens` for the thinking phase.

## Reproducibility contract

Runner:

```text
experiments/automationbench-fireworks-lora-serving/run-eval.mjs
```

Required comparison settings:

```text
protocol=native
max_tokens=2000
temperature=0
benchmark=automationbench-simple-api-offline
fixture=automationbench-simple-api-offline-v1
seed=7
```

Holdout must be run once per candidate with:

```text
--frozen-holdout-sha256 a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701
```

The dedicated deployment model address must include the `#deployment` suffix.
