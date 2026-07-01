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

**Quantization tax on agentic workloads (measured 2026-06-11):** 4-bit is a
fine default for chat/drafting, but on tool-calling benches it measurably
costs whole tasks — across families, on the same 10-task harness with
sampling and token caps held equal: Nemotron 3 Nano went 2/10 hosted → 0/10
as MLX 4-bit (lost both wins); DiffusionGemma's only solved task came at
BF16; AR Gemma 4 26B-A4B's BF16 rung recovered misses its 4-bit made. The
weaker a model's baseline tool-calling, the larger the tax. For agentic
evals: treat 4-bit scores as lower bounds, and re-measure on the BF16 rung
(now published for every ladder model) before concluding a model can't do a
workload.

## Understudy verified MLX ladder

Use this ladder before sending a new user to open-ended model browsing. It keeps
the first aha moment fast, then gives clear ways to climb within Gemma/Nemotron
or graduate remote when local quality is the bottleneck.

| Rung | Runtime | Snapshot / source | Use when |
|---|---|---|---|
| **Gemma 4 E2B QAT (Understudy, g32)** | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy` | **Default onboarding rung.** QAT bf16 -> MLX 4-bit `group_size=32`. About 3.6 GB; 4/4 certified (generation, OpenAI-compatible serving, logprobs+top_logprobs, tool_calls) at the prescribed decode (1.0/0.95/k64). Matches-or-beats vanilla BF16 on tool-call fidelity at 2.6x less memory and 2.6x faster decode. Serve with `--top-logprobs-k 20` — see `understudy.serving.json` and `references/serving-manifest.md`. |
| Gemma 4 E2B 4-bit (vanilla) | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-4bit` | Diagnostic rung (vanilla non-QAT bf16 -> MLX 4-bit). Keep it to isolate "is this a quant artifact?" questions against the QAT default. About 3.3 GB; verified generation, OpenAI-compatible serving, logprobs/top-logprobs. |
| Gemma 4 E2B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e2b-it-mlx-vlm-bf16` | Full-precision diagnostic rung for small-model quality checks. About 9.5 GB. |
| Gemma 4 E4B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-4bit` | First climb when E2B understands the task but lacks quality. About 4.8 GB; verified signed snapshot delivery. Official target for this tier: `gemma-4-e4b-it-qat-mlx-vlm-understudy` (QAT conversion staged; certification + publication pending) — switch to it once its session URL resolves. |
| Gemma 4 E4B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-e4b-it-mlx-vlm-bf16` | Full-precision E4B diagnostic when 4-bit quality looks suspicious. About 15 GB. |
| Gemma 4 12B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-4bit` | M4/M5 MacBook Pro or high-RAM Air rung when E4B has the right behavior but not enough depth. About 6.3 GB; verified generation plus OpenAI-compatible logprobs/top-logprobs. Official target for this tier: `gemma-4-12b-it-qat-mlx-vlm-understudy` (QAT conversion staged; certification + publication pending). |
| Gemma 4 12B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-12b-it-mlx-vlm-bf16` | Quality/perf profiling rung on larger-memory Macs. About 22 GB; use when quantization may be the bottleneck. |
| **Gemma 4 26B A4B QAT (Understudy)** | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-qat-mlx-vlm-understudy` | **Primary MoE-style climb.** Certified MLX 4-bit QAT MoE (`group_size=32` + 8-bit routers) from Google's QAT checkpoint. About 16 GB; certified generation, logprobs/top-logprobs, and tool calls. |
| Gemma 4 26B A4B 4-bit (vanilla) | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-4bit` | Diagnostic sibling of the QAT rung (and interim pull while the QAT snapshot publication lands). About 14 GB; verified generation plus logprobs/top-logprobs. |
| Gemma 4 26B A4B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-26b-a4b-it-mlx-vlm-bf16` | Full-precision MoE high end for 64 GB+ Macs when 4-bit quality is in question. About 52 GB. |
| Gemma 4 31B 4-bit | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-4bit` | Workstation/high-memory local rung when dense capacity matters. About 17 GB; verified generation plus logprobs/top-logprobs. |
| Gemma 4 31B BF16 | `mlx_vlm.server` | `https://models.understudylabs.com/session?model=gemma-4-31b-it-mlx-vlm-bf16` | Full-precision dense high end for 96 GB+ Macs. About 62 GB. |
| DiffusionGemma 26B A4B 4-bit | `mlx_vlm.server` (mlx-vlm ≥ 0.6.3) | `https://models.understudylabs.com/session?model=diffusiongemma-26b-a4b-it-mlx-vlm-4bit` | Block-diffusion variant of the 26B A4B MoE. About 16 GB; verified generation, chat completions, and tool calls. See the diffusion note below before picking it for speed. |
| DiffusionGemma 26B A4B BF16 | `mlx_vlm.server` (mlx-vlm ≥ 0.6.3) | `https://models.understudylabs.com/session?model=diffusiongemma-26b-a4b-it-mlx-vlm-bf16` | Full-precision diffusion rung for 64 GB+ Macs. About 52 GB; on bandwidth-bound Apple Silicon it decodes slightly *faster* than the 4-bit snapshot (diffusion decode is compute-bound), so prefer it when memory allows. |
| Nemotron 3 Nano 4B | MLX / GGUF / remote | NVIDIA source or verified snapshot | Alternate edge rung when agentic reasoning or tool behavior beats Gemma on the workload. |
| Nemotron 3 Nano 30B-A3B | `mlx_lm.server` on 32 GB+ | `mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit` (about 18 GB) | MoE climb when you need stronger reasoning while keeping active-parameter speed. Omni variant: `mlx-community/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-nvfp4` (about 20 GB) for multimodal + reasoning. |
| Super / Ultra | Remote | Understudy gateway / provider route | Not local rungs today: Ultra 4-bit MLX is ~347 GB; Super's only published MLX build is 9-bit at ~136 GB, over even a 128 GB Mac (a self-converted 4-bit Super ≈ 65 GB would fit but needs the ~240 GB BF16 source pull). Route remote via the gateway instead. |

Cloudflare delivery note: public installation uses stable session endpoints from
`models.understudylabs.com`. Each session response contains short-lived signed
per-file URLs; publish the session endpoint, not the expiring object URLs. R2
remains the durable object source.

Publication check: before promising any pull, hit the session endpoint. A
response of `{"error":"unknown model"}` means that rung — even a certified
`-understudy` one — has not been published/registered on the snapshot service
yet. Fall back to the matching vanilla rung as an interim, say so, and retry
the official rung later. Never send a user into a dead 404 during onboarding.

CLI snapshot pull:

```bash
understudy models snapshots
understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy --dry-run
understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy
understudy models pull --all
```

Once pulled, serve it with the manifest-driven helper so the required flags
(`--top-logprobs-k 20`) and prescribed decode are applied automatically:

```bash
node scripts/serve-understudy-snapshot.mjs --model gemma-4-e2b-it-qat-mlx-vlm-understudy   # prints the exact command
node scripts/serve-understudy-snapshot.mjs --model gemma-4-e2b-it-qat-mlx-vlm-understudy --exec  # spawns it
```

The pull command writes verified snapshots to `~/.understudy/models/<model-id>` and
logs to `~/.understudy/agent-tools/logs/model-pull-*.log`. The climb order is
the official `-understudy` ladder: `gemma-4-e2b-it-qat-mlx-vlm-understudy` →
`gemma-4-e4b-it-qat-mlx-vlm-understudy` (interim until published:
`gemma-4-e4b-it-mlx-vlm-4bit`) → `gemma-4-12b-it-qat-mlx-vlm-understudy`
(interim: `gemma-4-12b-it-mlx-vlm-4bit`) →
`gemma-4-26b-a4b-it-qat-mlx-vlm-understudy`. Reach for a `-bf16` rung only
when quantization may be the bottleneck. The coding agent should request
approval with the model id, source, and GB before running it, especially
before `--all`.

Provenance and smoke test (canonical statement — other skills cross-reference
this paragraph instead of repeating it): every Understudy Gemma 4 snapshot in
the ladder was converted directly from the official Google checkpoints
(`google/gemma-4-e2b-it`, `google/gemma-4-e4b-it`, `google/gemma-4-12b-it`,
`google/gemma-4-26b-a4b-it`, `google/gemma-4-31b-it`) with `mlx-vlm 0.6.2`,
packaged with `SHA256SUMS`, and smoke-tested through `mlx_vlm.server` plus
OpenAI-compatible `/v1/chat/completions`; the 12B/26B/31B rungs were
additionally verified for `logprobs`/`top_logprobs`. The DiffusionGemma rungs
were converted from `google/diffusiongemma-26B-A4B-it` with `mlx-vlm 0.6.3`,
packaged with `SHA256SUMS`, and smoke-tested the same way plus native
tool-calling. The 26B-A4B/31B BF16 high-end rungs were likewise converted with
`mlx-vlm 0.6.3` from the official BF16 checkpoints. Prefer these tested snapshots over ad hoc local conversions when
reproducing Understudy workflows.

DiffusionGemma note (measured on an M5 Max, 128 GB, mlx-vlm 0.6.3): Google's
"up to 4x faster" claim comes from arithmetic intensity on compute-bound GPUs
and does **not** transfer to bandwidth-bound Apple Silicon — long-form decode
measured ~68 tok/s (4-bit) vs ~119 tok/s for the autoregressive
`gemma-4-26b-a4b-it-mlx-vlm-4bit` sibling, while prefill was ~1.8x faster.
Because the 256-token canvas makes decode compute-bound, BF16 decodes slightly
faster than 4-bit (~78 vs ~68 tok/s); quantization buys memory, not speed.
Pick DiffusionGemma for its behavior (block drafting, infilling-style edits),
not for throughput. Serving tool calls requires mlx-vlm newer than 0.6.3 or a
patched 0.6.3: stock 0.6.3 strips the gemma tool-call/escape marker tokens in
the diffusion decode lane, so structured `tool_calls` never parse (the fix is
to keep `<|tool_call>`, `<tool_call|>`, `<|"|>`, `<|channel>`, `<channel|>`
out of the skipped-special-ids set in `server/generation.py`).

Two more measured caveats for serving (mlx-vlm 0.6.3): (1) **reliability** —
a client disconnect mid-canvas can wedge the diffusion generation lane (HTTP
stays up, generation never completes); long-running harnesses should
health-check the server with a small completion between tasks and restart on
failure. (2) **never request `temperature: 0` (or omit temperature — the
server default is 0)**. A diffusion LM's reference decode is *sampling* at
its built-in linear t-schedule (0.8→0.4); the schedule IS the temperature.
mlx-vlm maps OpenAI `temperature<=0` to argmax denoising — an unsupported
greedy mode that silently corrupts structured output in long/hard contexts
(measured: nested-JSON tool arguments truncate at internal quotes; the HF
transformers reference on the identical 3.9K-token context is flawless, and
the same server at `temperature: 1.0` is clean across seeds). Always send
`temperature: 1.0` plus a `seed` for reproducibility; eval harnesses that
default to temp 0 for AR models must override it for diffusion rungs.

## Recommended serving settings (pre-researched)

Pre-research serving settings **at pull time** — read the snapshot's
`generation_config.json` and the model card before the first bench, and send
the settings explicitly on every request. MLX servers (`mlx_lm.server`,
`mlx_vlm.server`) map an **omitted** temperature to 0 = greedy, which is
off-spec for every `do_sample: true` model and breaks diffusion LMs. Use a
fixed `seed` for reproducibility, never `temperature: 0`.

| Model family | Prescribed sampling (from `generation_config.json`) | Notes |
|---|---|---|
| Gemma 4 (all AR rungs) | `temperature 1.0, top_k 64, top_p 0.95` (`do_sample: true`) | Tolerates greedy in practice, but temp-0 results are off-spec — label them. |
| DiffusionGemma | `temperature 1.0` + `seed` — **never 0, never omitted** | Built-in linear t-schedule 0.8→0.4 is the real temperature; ≤48 denoising steps, entropy bound 0.1, 256-token canvas. Greedy denoise corrupts long-context structured output (see decode note above). |
| Nemotron 3 Nano 30B-A3B | `temperature 1.0, top_p 1.0` (`do_sample: true`) | Greedy produces search-looping on agentic tasks. |
| Qwen3.6 (commonly cached peer) | `temperature 1.0, top_k 20, top_p 0.95` (`do_sample: true`) | Tolerates greedy; same labeling rule applies. |

When adding a new model to the cache or ladder, append its row here as part of
the pull — the bench harness should never have to guess.

Small full-precision diagnostic note: `gemma-4-e2b-it-mlx-vlm-bf16` and
`gemma-4-e4b-it-mlx-vlm-bf16` are the smaller BF16 rungs. Use them to
distinguish model-size limits from quantization damage before jumping to 12B
or remote.

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

Full-precision high end: the BF16 rungs for `gemma-4-26b-a4b-it` and
`gemma-4-31b-it` are published as Understudy signed snapshots
(`session?model=gemma-4-26b-a4b-it-mlx-vlm-bf16` /
`gemma-4-31b-it-mlx-vlm-bf16`, converted with `mlx-vlm 0.6.3`), completing
full-precision coverage of the Gemma ladder. They are large — about 52 GB and
62 GB — so keep them behind explicit approval and a disk/RAM check; the
official BF16 source directories also still load directly with
`mlx_vlm.server` on 128 GB machines, but the signed snapshots are the
reproducible path.

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
