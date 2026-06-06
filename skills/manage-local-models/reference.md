# Manage Local Models — reference

Where weights come from, where they land, how to read formats, and how to budget
disk. Verify ids, sizes, and license terms against the official source before
quoting — links move and quantizations get re-cut.

## Where to get weights (the links users ask for)

| Source | URL | Use it for |
|---|---|---|
| Hugging Face Hub | `https://huggingface.co` | Canonical home for open weights + model cards. Search the org, read the card, check the license. |
| Ollama library | `https://ollama.com/library` | One-command local pulls (GGUF). Simplest path; serves Gemma without an HF token. |
| LM Studio | `https://lmstudio.ai/models` | GUI model browser + local OpenAI-compatible server. |
| NVIDIA (Nemotron) | `https://huggingface.co/nvidia` · `https://build.nvidia.com` · `https://developer.nvidia.com/nemotron` | Nemotron 3 weights, cards, and hosted previews. |
| Google (Gemma) | `https://huggingface.co/google` · `https://ai.google.dev/gemma` · Kaggle Models | Gemma 4 weights and docs (license acceptance required). |
| Unsloth | `https://huggingface.co/unsloth` | Pre-quantized GGUF/MLX cuts of Gemma & Nemotron, often with day-one fixes. |

Direct examples (confirm before pulling): `ollama.com/library/gemma`,
`ollama.com/library/nemotron-3-nano`, `huggingface.co/google` (Gemma 4),
`huggingface.co/nvidia` (Nemotron 3), `huggingface.co/unsloth` (GGUF/MLX).

## Where weights land (cache locations)

| Runtime | Default cache | Relocate with |
|---|---|---|
| Ollama | `~/.ollama/models` | `OLLAMA_MODELS=/Volumes/ext/ollama` (export before `ollama serve`) |
| Hugging Face (transformers, MLX, hf CLI) | `~/.cache/huggingface/hub` | `HF_HOME=/path` or `HF_HUB_CACHE=/path` |
| LM Studio | `~/.lmstudio/models` | set in the app's settings |
| llama.cpp | wherever you saved the `.gguf` | manual; keep them in one dir |

Inventory what's already on disk before downloading more:

```bash
ollama list                                  # cached Ollama models
du -sh ~/.ollama/models 2>/dev/null          # Ollama disk used
hf cache scan 2>/dev/null || huggingface-cli scan-cache 2>/dev/null   # HF cache
du -sh ~/.cache/huggingface/hub 2>/dev/null  # HF disk used
df -h ~                                       # free space
```

Reclaim space: `ollama rm <model>`, or `hf cache delete` / `huggingface-cli
delete-cache` for the HF cache.

## Formats

| Format | Runtimes | Notes |
|---|---|---|
| **GGUF** | llama.cpp, Ollama, LM Studio | Quantized, single-file, CPU/GPU. The default for local on a laptop. |
| **MLX** | MLX / `mlx_lm` | Apple-Silicon-native; best tokens/sec on Macs. |
| **safetensors** | Transformers, vLLM, SGLang | Full-precision weights; for serving on GPUs or converting to GGUF/MLX. |

## Quantization (what you trade for disk)

Lower precision = smaller + faster, with some quality loss. Common GGUF levels,
worst→best quality: `Q4_K_M` (the usual sweet spot) → `Q5_K_M` → `Q6_K` → `Q8_0`
(near-lossless) → `F16` (full). Start at Q4_K_M; only go higher if an eval shows
the quant is the bottleneck.

**Rule of thumb (q4):** ~0.5 GB of weights per billion parameters, plus KV cache
for context.

| Model | Params | ~q4 weights on disk |
|---|---|---|
| Gemma 4 E4B | ~4.5B eff. | ~3–4 GB |
| Nemotron 3 Nano 4B | 4B | ~3 GB |
| Gemma 4 12B | 12B | ~7–8 GB |
| Nemotron 3 Nano 30B-A3B | 30B total (3B active) | ~18–20 GB (sized by total params) |
| Gemma 4 31B dense | 30.7B | ~18–20 GB |

**MoE memory vs speed:** a Mixture-of-Experts model holds *all* experts in memory
(disk/RAM sized by **total** params) but only activates a few per token, so it
runs at the **active**-param speed. "30B but 3B active" = 30B-sized download, ~4B
inference speed.

**Context / KV cache:** longer context needs more RAM for the KV cache, on top of
weights. On tight memory, serve with flash attention and a quantized KV cache —
e.g. Ollama: `OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0 ollama serve`.

## Gated weights & tokens

Some families (Gemma among them) gate downloads behind license acceptance:

1. Open the model page on Hugging Face and **accept the license** while signed in.
2. Create a **read** token at `https://huggingface.co/settings/tokens`.
3. Authenticate: `hf auth login` (or `huggingface-cli login`), or set
   `HF_TOKEN=...` in the environment for the pull only.

Never print the token, write it to a repo file, or commit it. The **Ollama path
avoids the token entirely** for Gemma — prefer it for first-timers.

## Hardware fit (local, q4)

- **8–16 GB** — E2B/E4B and Nano-4B class only.
- **32 GB** — comfortably runs a 30B-A3B MoE or a 12B dense; a 31B dense is tight
  with long context (quantize the KV cache).
- **64–128 GB** — Nemotron 3 Super (~120B-A12B) and larger become viable.
- Everything bigger (e.g. Nemotron Ultra) is remote-only — graduate via
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

See [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) for
variant tables, benchmarks, and indicative cloud prices.
