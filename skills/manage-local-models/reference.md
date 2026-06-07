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

## Understudy verified MLX ladder

Use this ladder before sending a new user to open-ended model browsing. It keeps
the first aha moment fast, then gives clear ways to climb within Gemma/Nemotron
or graduate remote when local quality is the bottleneck.

| Rung | Runtime | Snapshot / source | Use when |
|---|---|---|---|
| Gemma 4 E2B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit` | Default onboarding rung. About 3.3 GB; verified local generation, Pi serving, and logprobs/top-logprobs. |
| Gemma 4 E2B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-bf16` | Full-precision diagnostic rung for small-model quality checks. About 9.5 GB; converted directly from `google/gemma-4-e2b-it` with `mlx-vlm 0.6.2` and smoke-tested through OpenAI-compatible chat. |
| Gemma 4 E4B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit` | First climb when E2B understands the task but lacks quality. About 4.8 GB; Understudy-converted and load-tested with `mlx_vlm.server` plus OpenAI-compatible chat. |
| Gemma 4 E4B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-bf16` | Full-precision E4B diagnostic when 4-bit quality looks suspicious. About 15 GB; converted directly from `google/gemma-4-E4B-it` with `mlx-vlm 0.6.2` and smoke-tested through OpenAI-compatible chat. |
| Gemma 4 12B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit` | M4/M5 MacBook Pro or high-RAM Air rung when E4B has the right behavior but not enough depth. About 6.3 GB; verified generation plus OpenAI-compatible logprobs/top-logprobs. |
| Gemma 4 12B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16` | Quality/perf profiling rung on larger-memory Macs. About 22 GB; use when quantization may be the bottleneck. |
| Gemma 4 26B A4B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-4bit` | MoE-style local climb for strong quality with lower active-parameter cost. About 14 GB; converted directly from `google/gemma-4-26B-A4B-it` with `mlx-vlm 0.6.2` and verified through OpenAI-compatible chat completions plus logprobs/top-logprobs. |
| Gemma 4 31B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-4bit` | Workstation/high-memory local rung when dense capacity matters. About 17 GB; converted directly from `google/gemma-4-31B-it` with `mlx-vlm 0.6.2` and verified through OpenAI-compatible chat completions plus logprobs/top-logprobs. |
| Nemotron 3 Nano 4B | MLX / GGUF / remote | NVIDIA source or verified snapshot | Alternate edge rung when agentic reasoning or tool behavior beats Gemma on the workload. |
| Nemotron 3 Nano 30B-A3B | MLX/GGUF on 32 GB+ or remote | NVIDIA source or gateway route | MoE climb when you need stronger reasoning while keeping active-parameter speed. |
| Super / Ultra | Remote or workstation | Understudy gateway / provider route | Use when local cannot meet the quality bar or the Mac does not fit the weights comfortably. |

Cloudflare delivery note: public installation uses stable session endpoints from
`models.understudylabs.com`. Each session response contains short-lived signed
per-file URLs; publish the session endpoint, not the expiring object URLs. R2
remains the durable object source.

Skill-owned pull helper:

```bash
cd /path/to/skills/manage-local-models
node scripts/pull-understudy-snapshot.mjs --model gemma-4-e2b-it-mlx-vlm-4bit --dry-run
node scripts/pull-understudy-snapshot.mjs --model gemma-4-e2b-it-mlx-vlm-4bit
```

The helper writes verified snapshots to `~/.understudy/models/<model-id>` and
logs to `~/.understudy/agent-tools/logs/model-pull-*.log`. Use
`gemma-4-e4b-it-mlx-vlm-4bit` for the first quality climb, then
`gemma-4-e4b-it-mlx-vlm-bf16` or `gemma-4-12b-it-mlx-vlm-bf16` when
quantization may be the bottleneck. It is intentionally a
skill helper, not a public CLI surface; the coding agent should request approval
with the model id, source, and GB before running it.

E4B note: use `~/.understudy/models/gemma-4-e4b-it-mlx-vlm-4bit` from the
Understudy pull helper when you want the tested E4B rung. The snapshot is an
Understudy-managed MLX-VLM package with `SHA256SUMS`; we verified the signed
Cloudflare snapshot downloads, matches checksums, loads with `mlx_vlm.server`,
and answers an OpenAI-compatible chat completion. Prefer this tested snapshot
over ad hoc local conversions when reproducing Understudy workflows.

Small full-precision diagnostic note: `gemma-4-e2b-it-mlx-vlm-bf16` and
`gemma-4-e4b-it-mlx-vlm-bf16` are the smaller BF16 rungs. They were converted
directly from the official Google checkpoints with `mlx-vlm 0.6.2`, packaged
with `SHA256SUMS`, and load-tested through `mlx_vlm.server` plus
OpenAI-compatible `/v1/chat/completions`. Use them to distinguish model-size
limits from quantization damage before jumping to 12B or remote.

Known-good high-end smoke:

```bash
python -m mlx_vlm.server \
  --model ~/.understudy/models/gemma-4-26b-a4b-it-mlx-vlm-4bit \
  --host 127.0.0.1 --port 8094

curl -s http://127.0.0.1:8094/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"~/.understudy/models/gemma-4-26b-a4b-it-mlx-vlm-4bit","messages":[{"role":"user","content":"Answer in exactly three words: what is local inference?"}],"max_tokens":24,"temperature":0}'
```

Expected shape: HTTP 200, a `choices[0].message.content` answer such as
`Running models locally.` or `AI runs locally.`, `finish_reason: "stop"`, and
usage counts. Repeat the same smoke for `gemma-4-31b-it-mlx-vlm-4bit`. This is
the supported functional check; raw `mlx_vlm.generate()` can emit odd text if the
chat template is bypassed.

Full-precision high end: on a 128 GB Apple Silicon machine, the official
`google/gemma-4-26B-A4B-it` and `google/gemma-4-31B-it` BF16 source directories
also load directly with `mlx_vlm.server` and pass the same chat smoke. They are
large gated downloads, about 48 GB and 58 GB respectively, so keep them behind
explicit approval and a disk/RAM check. The public Understudy signed snapshots
currently publish the 4-bit 26B/31B rungs; full-precision source pulls remain a
separate gated-weight workflow.

Remote graduation note: when a local rung is too small, use
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) to
run `understudy login --email <developer-email>`, store the API key through the
CLI, list remote model IDs, and route the workload to larger Gemma/Nemotron
variants without changing application code.

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
