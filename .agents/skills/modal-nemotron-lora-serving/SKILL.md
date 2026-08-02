---
name: modal-nemotron-lora-serving
description: Deploy, reuse, route, benchmark, and scale a Modal vLLM Nemotron multi-LoRA endpoint.
---

# Modal Nemotron multi-LoRA serving

The lab app uses `scripts/modal-vllm-nemotron-lora.py`, a durable Modal
deployment with a cached base-model Volume and an adapter Volume. Adapter names
and source metadata are tracked in
`runtime-assets/nemotron-lora-registry.json`.

## Deploy or reuse

Normalize Modal credentials before every CLI operation:

```bash
export MODAL_TOKEN_ID="$(printf %s "$MODAL_TOKEN_ID" | tr -d '[:space:]')"
export MODAL_TOKEN_SECRET="$MODAL_SECRET"
modal deploy scripts/modal-vllm-nemotron-lora.py
```

The endpoint URL follows:

```text
https://<workspace>--understudy-nemotron-vllm-lab-serve.modal.run
```

The pinned image is `vllm/vllm-openai:v0.26.0`. Nemotron-H LoRA support was
merged in vLLM PR #30802 and is present in this release. The server enables
native multi-LoRA, runtime adapter updates, and the `qwen3_xml` parser for the
Nemotron-3 tool-call template:

```text
--enable-lora --max-loras 4 --max-lora-rank 64
--enable-auto-tool-choice --tool-call-parser qwen3_xml
```

The production-safe default starts base-only. Load only a converted, validated
adapter at runtime; a bad adapter then cannot crash-loop base startup:

```text
POST /v1/load_lora_adapter
{"lora_name":"adapter-rank8","lora_path":"/adapters/nemotron-rank8-converted"}
```

`scripts/convert-nemotron-tinker-lora.py` expands stacked Tinker `w1`/`w2`
expert factors into `experts.<id>.up_proj`/`down_proj` and rewrites the PEFT
target list. It reports source tensor coverage and deliberately drops the
incompatible Mamba `gate_proj`/`x_proj` factors. The rank-8 conversion maps
97.4134% of source LoRA tensor elements; the dropped classes are recorded in
`experiments/modal-nemotron-lora/serving-config.json`.

## Upload or hot-load an adapter

Upload a PEFT adapter without changing the app:

```bash
modal volume put understudy-nemotron-lora-adapters \
  /home/ubuntu/adapters/<adapter> /<adapter>
```

For a runtime adapter, use `NemotronLoraClient.loadLoraAdapter` with the
registry's `volumePath`, then route requests by setting `model` to the
registry name. Unload with `unloadLoraAdapter` when no longer needed.

## Warm-keep and teardown

The default `scaledown_window=300` scales to zero after five idle minutes.
For a temporary warm-keep probe, set `min_containers=1` on the Modal function
and redeploy; remove it afterward to restore scale-to-zero. Do not leave warm
containers running outside a bounded experiment.

```bash
modal app stop understudy-nemotron-vllm-lab
modal app list
```

Volumes persist independently of compute and may remain after teardown.

## Orchestration and artifacts

Modal is an executor, not a workflow controller. A Vercel Workflow invokes a
deployed Modal function through an idempotent experiment-executor contract.
Evaluation output is immutable `understudy.eval_result.v1` JSONL plus an
`understudy.eval_summary.v1` summary containing SHA-256 references; pass artifact
references and hashes rather than prompts, traces, credentials, or weights.
