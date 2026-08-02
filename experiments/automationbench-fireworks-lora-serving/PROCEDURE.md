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

| Adapter | Base | Actual target modules | Capability |
|---|---|---|---|
| `abo-nemotron-nano3-30b-sft-r16-v1` | `nemotron-nano-3-30b-a3b` | `down_proj, in_proj, k_proj, o_proj, out_proj, q_proj, up_proj, v_proj` | **Unservable**: `in_proj`, `out_proj` are unsupported Mamba modules |
| `ab-gemma4-26ba4b-oracle-sft-r16-e3` | `gemma-4-26b-a4b` | `base_layer, down_proj, experts, gate_proj, k_proj, o_proj, q_proj, up_proj, v_proj` | **Unservable**: `experts`, `base_layer` unsupported |
| `ab-gemma4-31b-oracle-sft-r16-e3` | `gemma-4-31b` | `down_proj, gate_proj, k_proj, o_proj, q_proj, up_proj, v_proj` | **Servable in principle**; blocked in this run by GPU quota |
| `qwen3-8b-abo-simpleapi-sft-r16e3` | `qwen3-8b` | supported dense projection modules | **Servable**; measured pair |

## Working path: live merge (recommended for one adapter)

Live merge supports native tool calls and requires no addon flags:

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
- Addon deployments do not support native tool calling.
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
above. Treat this silent-success-then-404 pattern as an adapter capability or
serving-path failure, not proof of a usable deployment.

```text
draft model precision validation failed: addons cannot be enabled with quantized precisions (FP8/FP4)
```

```text
invalid deployment: addons cannot be enabled with quantized precisions (FP8/FP4)
```

```text
"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set
```

Dedicated addon deployments expose no `firectl create deployment` flags for
the two required native-tool settings. Native tool calls work on live-merge
deployments, but not on addon deployments.

```text
Internal error occurred, please contact the Fireworks AI team at https://discord.gg/fireworks-ai
```

This occurred twice for a Qwen3-8B BF16 `--enable-addons` deployment; both
deployments entered `state FAILED`.

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
