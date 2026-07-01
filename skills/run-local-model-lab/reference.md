# Run Local Model Lab Reference

Depth for [`SKILL.md`](SKILL.md). Keep this reference current by checking
official model cards, runtime docs, and local hardware before recommending a
download or route change.

## Runtime chooser

Use the easiest OpenAI-compatible endpoint that fits the developer's machine and
workload:

- **llama.cpp / GGUF** — default for cross-platform and coding-sandbox use: a
  single binary, no daemon, and `llama-server -hf <repo>:<quant>` pulls weights
  straight from Hugging Face (works the day a model drops).
- **MLX** — default on Apple Silicon when an MLX build exists; best throughput on
  a Mac, pulls from Hugging Face.
- **Ollama / LM Studio** — optional convenience fallback if a developer already
  runs one; skip as the default because their library tags lag new HF releases.
- **vLLM / SGLang** — prefer on NVIDIA or server GPUs when batching,
  throughput, or OpenAI-compatible serving matters.
- **Transformers / LiteRT-LM** — use for modality-specific demos, QAT/mobile
  checkpoints, or when the model card's reference path is the only reliable
  implementation.

Always record the endpoint, runtime, model id, quantization, context setting,
and hardware in `.understudy/local-model-lab/`.

## Install → download → serve → infer (the operational path)

Most developers — and agents in coding sandboxes — won't have a runtime or
weights yet, so the skill has to bootstrap both. Only act after the SKILL's
gates: no downloads without an explicit size cap, and gated weights (Gemma) need
the model terms accepted + an `HF_TOKEN` (a token authorizes a download; it is
not approval to download). Pick the lightest runtime that fits; each exposes an
OpenAI-compatible endpoint, so the frozen eval just swaps `base_url`.

### llama.cpp — cross-platform, single binary, best for sandboxes (pulls weights itself)

```bash
brew install llama.cpp                 # macOS; else build from source / package mgr
export HF_TOKEN=...                     # only for gated repos; never commit it
# downloads the GGUF from HF and serves OpenAI-compatible at :8080/v1
llama-server -hf unsloth/gemma-4-E4B-it-GGUF:Q4_K_M --port 8080 --jinja
# Nemotron 3 Nano — smallest gen-3 is the 4B dense; 30B-A3B is the MoE:
#   llama-server -hf nvidia/NVIDIA-Nemotron-3-Nano-4B-GGUF:Q4_K_M --port 8080 --jinja
#   llama-server -hf unsloth/Nemotron-3-Nano-30B-A3B-GGUF:Q4_K_M --port 8080 --jinja
```

### MLX — Apple Silicon native (best throughput on a Mac)

```bash
pip install mlx-vlm                      # or: uv pip install mlx-vlm
# pull the official Understudy snapshot first, then serve OpenAI-compatible.
# The certified QAT `-understudy` rungs are the primary lab models:
cd /path/to/understudy-agent-tools/skills/manage-local-models
understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy
python -m mlx_vlm.server --model ~/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy --port 8080 --top-logprobs-k 20
# E4B tier: official target gemma-4-e4b-it-qat-mlx-vlm-understudy (pending
# certification + publication); until then climb to the 26B-A4B QAT rung
# Nemotron 3 Nano on MLX: mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit
```

Prefer the `-understudy` suffixed snapshot ids in this lab — they are the
certified QAT conversions Understudy trains and stands behind (each ships an
`understudy.serving.json` with the exact serve flags), and they are the only
ids the snapshot service delivers. For a tier without a published
`-understudy` rung, convert a vanilla `-mlx-vlm-4bit` rung locally (provenance
and smoke-test details:
[`../manage-local-models/reference.md`](../manage-local-models/reference.md)).

(Ollama / LM Studio also serve OpenAI-compatible if a developer already runs one,
but skip them as the default: their library tags lag new HF releases, so brand-new
models like Gemma 4 / Nemotron 3 may not have a tag yet — `llama.cpp -hf` and MLX
pull straight from Hugging Face the day weights drop.)

### Download weights explicitly (any runtime)

```bash
# accept the model's terms on its HF page first, then:
export HF_TOKEN=...                       # gated models only; never commit
hf download google/gemma-4-e4b-it --local-dir ./models/gemma-4-e4b-it
# or a prebuilt quant: hf download unsloth/gemma-4-E4B-it-GGUF <file>.gguf
```

### Smoke-test the local endpoint, then run the eval

```bash
curl -sS http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"reply: pong"}],"max_tokens":20}'
```

Then run the frozen eval with `base_url=http://localhost:8080/v1` (or the gateway
primitive's `--api-base-url`) — same harness, local model.

Notes: exact repo ids and quant tags drift — verify on the model card. On Apple
Silicon prefer an MLX 4-bit build; for portability use a llama.cpp GGUF `Q4_K_M`.
Nemotron 3 Nano comes as a small **4B dense** (truly laptop/edge — a few GB at q4)
and a **30B-A3B MoE** (holds all experts in memory, ~16–18 GB at q4, but runs at
~4B speed). Use the 4B for cheap local smoke; the MoE for stronger local quality
on 32 GB+. (Nemotron is a reasoning model — final text follows a `reasoning`
block, so parse the last assistant `content`, not the reasoning.)

## Compare local vs remote (recipe + measured example)

Run the SAME frozen rows + prompt against the local endpoint and the remote
catalog model, score the objective + latency, and let the route decision fall out.

```bash
# remote side: route a workload to a catalog model, then run the eval via the gateway
understudy workloads route --model-id gemma-4-31b-it --traffic-pct 100
BASE=https://api.understudylabs.com/v1 KEY="$UNDERSTUDY_SK" MODEL=x  node eval.mjs  # remote
BASE=http://127.0.0.1:8080/v1          KEY=local             MODEL=x node eval.mjs  # local
```

Measured example — 6 support-triage rows, exact-match category + latency, on an
Apple Silicon laptop:

| | Local — Gemma 4 E4B (llama.cpp) | Remote — Gemma 4 31B (gateway) |
| --- | --- | --- |
| Accuracy | 5/6 | 6/6 |
| Latency p50 | ~77 ms | ~526 ms |
| Cost | $0 | provider pennies |
| Privacy | fully local | via gateway |

Decision: the small local model is ~7× faster, $0, and private, and handled the
easy cases; its one miss (a login/reset ticket it called `technical` while the 31B
got `account`) is the signal to escalate ambiguous cases. → **local-as-router /
hybrid**: serve easy traffic locally, escalate hard cases to the remote model.
Same family (Gemma E4B ↔ Gemma 31B) means the prompt transfers unchanged. Record
the run in `.understudy/local-model-lab/`.

## Candidate chooser

This is a starting heuristic, not a benchmark claim. Verify current model card
availability, license, checkpoint format, and runtime support before use.

| Candidate class | Use when | Notes |
| --- | --- | --- |
| E2B / E4B | Router, triage, extraction, easy classification, edge/mobile, audio-first smoke tests | Smallest Gemma 4 rungs. Good for cheap local iteration and compliance-constrained routing. Use the 4-bit rungs for speed/size; convert a BF16 rung locally when quantization may be the bottleneck. |
| 12B | Main laptop eval, multimodal/audio tasks, stronger reasoning without workstation hardware | Google announced Gemma 4 12B on 2026-06-03 as a unified encoder-free multimodal model designed for laptops with 16GB VRAM or unified memory. |
| 26B A4B MoE | Strong local text/image candidate on serious desktop/workstation hardware | Treat as the local quality/latency sweet spot when the runtime and memory fit. MoE active parameters do not remove the need to fit the checkpoint/KV cache. |
| 31B dense | Maximum local quality when hardware is available, or remote graduation target | Prefer remote/gateway if local ops friction or memory pressure slows the experiment. |
| Nemotron 3 Nano 4B | Smallest local Nemotron; routing/triage/edge on any laptop | Dense ~4B; GGUF at `nvidia/` and `unsloth/`. The cheapest gen-3 Nemotron rung. |
| Nemotron 3 Nano 30B-A3B | Stronger local Nemotron on 32 GB+; agentic/reasoning, long context | MoE (3B active) → ~4B speed; reasoning model. Mirrors remote `nemotron-3-nano`/`super`. |
| Target + `-assistant` | Latency optimization through speculative decoding | The `*-it-assistant` models are MTP drafters. Evaluate the target model's quality; measure the assistant as speedup only. |

## Gemma 4 facts to verify fresh

As of 2026-06-05, the official public shape is:

- Initial Gemma 4 family: E2B, E4B, 26B A4B MoE, and 31B Dense.
- Gemma 4 12B was added on 2026-06-03 to bridge E4B and 26B, with unified
  encoder-free multimodal architecture and native audio input.
- Gemma 4 QAT checkpoints were announced on 2026-06-05 for lower memory local
  deployment, including Q4_0/GGUF-oriented and mobile-oriented formats.
- Google lists common local/runtime paths including Ollama, LM Studio,
  llama.cpp, MLX, vLLM, SGLang, LiteRT-LM, Transformers, and Google AI Edge
  Gallery.
- Gemma access may require accepting model terms and using a Hugging Face token.
  A local token is authorization to download gated weights, not approval to
  download them in this workflow.

Do not encode stale footprint guesses as requirements. Approximate RAM/VRAM
numbers depend on quantization, context length, modality components, KV cache,
runtime, and batching. Use them only as planning estimates after checking the
exact artifact.

## Artifact schema

Write a small JSON record per run:

```json
{
  "runtime": "ollama|lmstudio|llama.cpp|mlx|vllm|sglang|transformers|litert-lm",
  "endpoint": "http://localhost:11434/v1",
  "model": "string",
  "model_role": "target|draft|router|judge|candidate",
  "quantization": "string|null",
  "hardware": {
    "device": "string",
    "ram_gb": 0,
    "vram_or_unified_memory_gb": 0
  },
  "workload": {
    "id": "string",
    "eval_rows": 0,
    "data_boundary": "local-only"
  },
  "results": {
    "score": 0,
    "latency_p50_ms": 0,
    "latency_p95_ms": 0,
    "tokens_per_second": 0,
    "failures": []
  },
  "decision": "ship-local|local-replay|local-router|hybrid|remote|escalate"
}
```

## Decision rules

- **Ship local** when quality is within the agreed regression band and privacy,
  latency, or unit economics beat the remote route at realistic volume.
- **Local replay only** when local is useful for no-spend iteration but not good
  enough for production behavior.
- **Local router / triage tier** when a small model reliably detects easy cases
  or routes hard cases to a stronger model.
- **Hybrid** when local handles private or easy stages and remote handles the
  high-value completion path.
- **Remote only** when local quality, latency, hardware setup, or ops burden
  slows the company more than provider spend would.
- **Escalate to workstation/GPU** only when the evidence says a larger local
  model could materially change the route decision.

## Anti-patterns

- Treating a local model as free without measuring setup time, hardware
  contention, latency, and maintenance.
- Comparing local and remote runs with different prompts, tools, eval rows, or
  validators.
- Downloading gated weights because a token exists.
- Evaluating `*-assistant` drafters as quality candidates.
- Claiming QAT or quantized quality from a model-card headline without running
  the workload's own heldout rows.
