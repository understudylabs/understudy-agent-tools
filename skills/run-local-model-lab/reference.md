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
llama-server -hf ggml-org/gemma-4-e4b-it-GGUF:Q4_K_M --port 8080 --jinja
```

### MLX — Apple Silicon native (best throughput on a Mac)

```bash
pip install mlx-lm                       # or: uv pip install mlx-lm
# pulls the MLX build from HF and serves OpenAI-compatible at :8080/v1
mlx_lm.server --model mlx-community/gemma-4-e4b-it-4bit --port 8080
```

(Ollama / LM Studio also serve OpenAI-compatible if a developer already runs one,
but skip them as the default: their library tags lag new HF releases, so brand-new
models like Gemma 4 / Nemotron 3 may not have a tag yet — `llama.cpp -hf` and MLX
pull straight from Hugging Face the day weights drop.)

### Download weights explicitly (any runtime)

```bash
# accept the model's terms on its HF page first, then:
export HF_TOKEN=...                       # gated models only; never commit
hf download google/gemma-4-e4b-it --local-dir ./models/gemma-4-e4b-it
# or a prebuilt quant: hf download ggml-org/gemma-4-e4b-it-GGUF <file>.gguf
```

### Smoke-test the local endpoint, then run the eval

```bash
curl -sS http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"reply: pong"}],"max_tokens":20}'
```

Then run the frozen eval with `base_url=http://localhost:8080/v1` (or the gateway
primitive's `--api-base-url`) — same harness, local model.

Notes: exact repo ids and quant tags drift — verify on the model card (Gemma
`e4b` / `12b`; Nemotron 3 Nano `30b-a3b`). On Apple Silicon prefer an MLX 4-bit
build; for portability use a llama.cpp GGUF `Q4_K_M`. Nemotron 3 Nano is a
30B-A3B MoE — it needs the full weights resident (~16–18 GB at q4) but runs at
~4B speed, so it's comfortable on 32 GB+ (trivial on your 128 GB).

## Candidate chooser

This is a starting heuristic, not a benchmark claim. Verify current model card
availability, license, checkpoint format, and runtime support before use.

| Candidate class | Use when | Notes |
| --- | --- | --- |
| E2B / E4B | Router, triage, extraction, easy classification, edge/mobile, audio-first smoke tests | Smallest Gemma 4 rungs. Good for cheap local iteration and compliance-constrained routing. |
| 12B | Main laptop eval, multimodal/audio tasks, stronger reasoning without workstation hardware | Google announced Gemma 4 12B on 2026-06-03 as a unified encoder-free multimodal model designed for laptops with 16GB VRAM or unified memory. |
| 26B A4B MoE | Strong local text/image candidate on serious desktop/workstation hardware | Treat as the local quality/latency sweet spot when the runtime and memory fit. MoE active parameters do not remove the need to fit the checkpoint/KV cache. |
| 31B dense | Maximum local quality when hardware is available, or remote graduation target | Prefer remote/gateway if local ops friction or memory pressure slows the experiment. |
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
