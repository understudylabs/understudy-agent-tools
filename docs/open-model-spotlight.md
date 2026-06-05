# Open-Model Spotlight: Gemma 4 & Nemotron 3

Two American, open-weight, well-documented model families that pair cleanly with
Understudy's **remote ↔ local** pattern. This doc is the reusable reference for
[`skills/use-understudy-gateway`](../skills/use-understudy-gateway/SKILL.md)
(remote inference + routing) and
[`skills/run-local-model-lab`](../skills/run-local-model-lab/SKILL.md) (local
experimentation).

Verify model ids, sizes, and prices against official sources before quoting —
prices below are indicative (~June 2026, third-party hosts) and move.

## The remote ↔ local pattern (the reusable part)

Iterate cheaply and privately on a **small local** model, then graduate to a
**larger remote** model in the Understudy catalog when you need the quality —
ideally within the **same family**, so prompts and behavior transfer:

```
local (small, $0 inference, private, ZDR/SOC2-safe)
        →  remote (larger, via Understudy: `understudy models` / `workloads` route)
same family ⇒ optimized prompts carry over with minimal rework
```

Run local with `run-local-model-lab`; route/serve remote with
`use-understudy-gateway`; compare both on one frozen eval (capture-evidence).

## Google Gemma 4

Launched **2026-04-02** (E2B, E4B, 26B-A4B MoE, 31B Dense); **12B Unified
~2026-06** (multimodal incl. audio, encoder-free). Optimizes the small-to-mid,
multimodal, on-device end.

| Variant | Size (active) | Context | Modalities |
|---|---|---|---|
| E2B / E4B | 2.3B / 4.5B eff. | 128K | text, image, audio |
| 12B Unified | 12B | 256K | text, image, audio |
| 26B A4B (MoE) | 25B / ~3.8B | 256K | text, image |
| 31B Dense | 30.7B | 256K | text, image |
| `*-it-assistant` | — | — | speculative-decoding **drafters**, not standalone |

Benchmarks (instruct): 31B — MMLU-Pro 85, GPQA 84, LiveCodeBench 80; 26B —
83/82/77; 12B — 77/79/72. Cloud (31B, indicative /1M): ~$0.12 in / $0.37 out
(third-party hosts; free tiers exist).

**Via Understudy** — remote: `gemma-4-31b-it`. Local (`run-local-model-lab`):
E2B / E4B / 12B / 26B-MoE / 31B — **$0 inference**.

## NVIDIA Nemotron 3

Hybrid **Mamba-Transformer MoE**, **1M-token context**, throughput-first,
agentic-reasoning focus, and the **most open release** (weights + ~3T pretraining
tokens + 18M post-training samples + RL gym environments). Nano launched
**2026-04-28**; Super & Ultra rolling out through 2026.

| Variant | Size (active) | Notable |
|---|---|---|
| Nano | 30B (3B) | smallest gen-3 chat; 4× throughput vs gen-2; Nano-Omni adds multimodal |
| Super | ~120B (~12B) | high-accuracy reasoning |
| Ultra | 550B (55B) | flagship, 300+ tok/s |

Cloud (indicative /1M): Nano ~$0.05 in / $0.20 out; Super ~$0.10 / $0.50 (free
tiers available); Ultra ~$0.60 / $3.60.

**Via Understudy** — remote: `nemotron-3-nano`, `nemotron-3-super`,
`nemotron-3-ultra`. Local (`run-local-model-lab`): Nano **4B** (smallest, dense —
laptop/edge) or Nano **30B-A3B** (MoE, ~4B speed; Nano-Omni adds multimodal).
Super 120B fits a high-memory workstation (64–128 GB Apple Silicon); Ultra is
remote-only.

## Remote ↔ local at a glance

| Family | Remote (Understudy catalog) | Local (run-local-model-lab) |
|---|---|---|
| Gemma 4 | `gemma-4-31b-it` | E2B / E4B / 12B / 26B-MoE / 31B |
| Nemotron 3 | `nemotron-3-nano`, `nemotron-3-super`, `nemotron-3-ultra` | Nano 4B / 30B-A3B (Super 120B on big-RAM) |

Hardware rule of thumb (local, q4): ~0.5 GB/param of weights + KV cache; an MoE
holds all experts in memory but runs at the active-parameter speed. A 30B-A3B
fits comfortably on a 32 GB+ machine; a 120B-A12B needs ~64–80 GB.

## Run it

```bash
# remote: pick a catalog model and route a workload to it
understudy models
understudy workloads route <workload-id> --project-id <project-id> --model-id nemotron-3-nano --traffic-pct 100
understudy run -- <your eval>

# local: serve a small model OpenAI-compatibly and run the same eval
#   ollama run gemma-4-e4b   (or a Nemotron 3 Nano GGUF)
#   then point the eval's base_url at the local endpoint
```

Pick the smallest model that passes your frozen eval; escalate only when it
doesn't. Never claim a cost/latency/quality win without a measured before/after.
