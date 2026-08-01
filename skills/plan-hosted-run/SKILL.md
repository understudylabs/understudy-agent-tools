---
name: plan-hosted-run
description: Use when a developer wants to run a hosted job — a fine-tune, an RL (reinforcement-learning) run, batch inference, or large-scale trajectory generation — and asks where, how long, and how much. "What would it cost to fine-tune this", "which provider should I use for this RL run", "is this cheaper locally or in the cloud". Estimates and routes; never spends.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Plan Hosted Run

One skill for the single question "I want to run a hosted job — **where**, **how
long**, and **how much**?" It has two halves that usually run together:

1. **Estimate** — a defensible back-of-envelope for wall-clock and dollars,
   local (Apple Silicon / MLX) versus cloud (rented GPU or serverless), with
   every input labeled measured-or-assumed. Methodology below; constants,
   benchmarks, and cited prices in
   [`references/cost-estimation.md`](references/cost-estimation.md).
2. **Route** — match the job shape to the provider whose strengths actually
   fit, with cited facts and honest caveats. Routing table below; per-provider
   detail and citations in [`references/providers.md`](references/providers.md).

This skill estimates and recommends. It never provisions, rents, or spends —
those are explicit, separate user actions. **Prices and features drift — verify
on the provider's live pricing page before any spend.**

Optimize the recommendation for reaching the workload objective, not for the
lowest sticker price. Present the recommended outcome-sized plan first, then a
cheaper diagnostic and a faster or higher-confidence option when useful. State
what each buys in capability, confidence, and time-to-answer; follow
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture.

## When to use

- "How long will fine-tuning / SFT / an RL run take on my Mac vs a rented GPU?"
- "What will it cost to generate N RL trajectories?" (policy rollouts at scale)
- "Where should I run this fine-tune / RL job / batch rollout?"
- "Who's cheapest/fastest for generating RL trajectories?"
- "I want managed GRPO vs I want to rent raw GPUs — who does which?"
- Sizing the spend before any hosted-RL handoff
  ([`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)).

Not for: choosing a *model*
([`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md)), the
authenticated Understudy gateway
([`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)),
or running the job itself.

## Safety Gates

- **Estimate and route only — never provision or spend.** This skill does not
  rent GPUs, start jobs, call paid APIs, or enter payment details.
- **Label every number.** Mark each input as *measured* (benchmarked on this
  machine / quoted from a live price page) or *assumed* (rule-of-thumb). An
  estimate built on assumptions must say so.
- **Prefer a measured local datapoint** over a generic benchmark when the
  hardware is available: a 2-minute throughput probe (tokens/sec on the actual
  machine) beats a number from someone else's M-series.
- **No silent staleness.** Cloud prices and serverless rates drift; cite the
  source and date of every dollar figure, and flag when a cited number may be
  out of date. Every fact in the references carries a source and date.
- **Range, not false precision.** Report a low/high band, not a single number,
  and name the dominant uncertainty (usually MFU for training, throughput for
  rollouts).
- **Factual and cited — no marketing.** Vendor performance claims ("40X
  faster") are marketing until independently benchmarked; present them as such
  or not at all. Honest caveats travel with the recommendation — if a fit
  depends on an unverified capability, say so.
- **No data-boundary advice by default.** If the workload has ZDR / residency /
  SOC2 constraints, surface that the choice is constrained and defer to the
  developer — do not assume a provider's compliance posture.

## Inputs to gather

Ask only for what the job type needs:

- **Job type**: SFT/LoRA, full fine-tune, RL (GRPO/DPO), batch inference, or RL
  trajectory generation.
- **Model**: parameter count N and quant (sets memory + per-token compute).
- **Data size**: training tokens D (≈ examples × avg tokens × epochs), or for
  inference/rollouts: num_prompts × rollouts × avg output tokens.
- **Hardware on hand**: chip + unified memory (local), or target GPU (cloud).
  The Understudy profile at `~/.understudy/profile.json` often has the local
  machine.

## The estimate

Two engines, picked by job type. Full constants, benchmarks, and cited prices
live in [`references/cost-estimation.md`](references/cost-estimation.md).

### Compute-bound work (training / fine-tuning)

1. **FLOPs** ≈ `6 × N × D` (forward+backward; the standard 6ND approximation —
   the reference cites the origin). LoRA reduces the *trainable* params but the
   forward/backward still flows through the full model, so use full N for
   wall-clock.
2. **Wall-clock** ≈ `FLOPs / (GPU_peak_FLOPS × MFU)`. Use realized MFU ~0.3–0.5,
   not peak. State the GPU's BF16 dense FLOPS from the reference.
3. **Local (MLX)** has no published MFU; instead use a measured tokens/sec from
   `mlx_lm.lora` (or the probe) and `wall-clock ≈ D / throughput`.
4. **Cost** = `wall-clock_hours × $/GPU-hour` (cloud) or **$0** (local,
   already-owned).

### Throughput-bound work (inference / RL trajectory generation)

1. **Total output tokens** = `num_prompts × rollouts × avg_output_tokens`
   (+ input tokens if a per-token rate charges for them).
2. **Serverless** cost = `total_tokens × $/token` (from a provider price page).
   Fast to start, no idle cost, but per-token adds up at scale.
3. **Rented deployment** cost =
   `(total_tokens / sustained_throughput) × $/GPU-hour`. Wins above a crossover
   volume because you amortize a flat hourly rate. The reference shows how to
   find the crossover.
4. **Local (MLX)** cost = **$0** but bounded by one machine's tokens/sec — fine
   for thousands of rollouts, slow for millions. Compute the wall-clock and let
   the developer judge if the time is acceptable.

**Cache tokens are their own line item.** Multi-turn/agentic workloads re-send
the growing context every turn, and with provider prompt caching most of those
tokens bill at cache-read/cache-write rates, not the base input rate. On
long-context workloads, cache-read tokens can exceed fresh input tokens by more
than 10× — an estimate priced entirely at the base input rate is wrong in
either direction. Pull the cache fields from measured usage
(`cache_read`/`cache_creation` or `cached_tokens`) and price each class at the
provider's current cached rates, cited with source + date like every other
dollar figure. Measured on an internal synthetic workload, 2026-05-22
(cache-read tokens >10× fresh input tokens on a long-context agentic loop).
To *improve* a workload's hit rate rather than just price it, see
[`optimize-workload/references/prompt-cache-optimization.md`](../optimize-workload/references/prompt-cache-optimization.md).

### Decide local vs cloud

Present **local vs cloud side by side**: wall-clock and dollars for each, with
the band and the dominant assumption. Recommend the route with the best expected
progress under the real time, quality, and budget constraints—not local merely
because its marginal dollar cost is zero. Cloud is often the correct answer when
local wall-clock, capacity, or iteration speed blocks the objective (typical for
RL training and large-scale rollouts — the Understudy local-SFT / cloud-RL
split). When the answer is cloud, continue to the routing below.

## The routing decision

Providers overlap a lot (most serve open weights over an OpenAI-compatible API
at similar prices); the decision is usually driven by one axis — managed-RFT vs
raw clusters, cheap per-token rollouts vs reserved throughput, or "I already
have quota/credits here." Match the job shape to the lead provider;
[`references/providers.md`](references/providers.md) has the full comparison.

| Job shape | Lead choice | Why (1-liner) | Alt |
|---|---|---|---|
| **Generate RL trajectories / cheap batch rollouts** of open-weight frontier models | **Together Batch** or **Fireworks RFT** | published batch/RFT paths and rate-limit posture | Lilac only after concurrency is confirmed |
| **RL training** (GRPO, multi-turn/agentic, reusable env) | **Prime Intellect** | `verifiers` env + `prime-rl` + Environments Hub + hosted Lab; scales 1→1000s GPUs | Fireworks if you want it fully managed |
| **Managed RFT** (reward fn → trained policy → served), least friction | **Fireworks** | self-serve GRPO RFT + reward-kit + one-click train→serve | — |
| **SFT / LoRA / DPO** then serve | **Fireworks or Together** | both do LoRA+full+DPO at ~$0.50/1M tok (≤16B), serve on same platform | — |
| **Cheap first LoRA probe** on an open-weight model, weights in hand | **Tinker** | per-token training API, no GPU-hour floor, downloadable adapter/merged weights | Fireworks when the result must be hosted on the same platform |
| **Raw GPU clusters** / run your own training/rollout engine at scale | **Together** (InfiniBand, up to 4,000+ GPUs) | bare-metal scale under one vendor | Prime Intellect marketplace (spot), or **Azure/GCP** if you hold quota/credits |
| **Serverless per-token inference** of open models | **Together / Fireworks / Lilac** | comparable OpenAI-compatible endpoints | — |
| **Hyperscaler** with existing quota/credits, Foundry/Vertex, data-residency | **Azure or GCP** | you manage the stack; good when already invested there | purpose-built RL/RFT providers |

A common pipeline: **generate rollouts through a published batch/RFT path
(Together Batch or Fireworks RFT) → train with Prime Intellect's verifiers +
prime-rl**. Lilac can be a cheap OpenAI-compatible probe path, but only promote
it for large rollouts after confirming concurrency and retry behavior with the
provider. Generation backend and training backend need not be the same vendor.

### Provider snapshots

One line each; full detail + citations in
[`references/providers.md`](references/providers.md).

- **GCP** — hyperscaler raw GPU (A100/L4/H100 via Compute Engine + Vertex AI).
  Route when you already have quota, credits, or data-residency needs; you own
  the stack.
- **Azure / Microsoft Foundry** — hyperscaler GPU + managed model-customization
  path. Route when Microsoft credits/quota, Foundry/OpenAI integration, or
  Azure data-boundary requirements dominate; NCads H100 v5 fits training/batch
  inference and Foundry documents SFT/DPO/RFT support by model.
- **Prime Intellect** — the open RL stack (`verifiers`, `prime-rl`,
  Environments Hub, hosted **Lab**) on a GPU marketplace (H100 ~$2.43/hr
  on-demand, ~$0.94 spot). Route for RL training you want to author once and
  scale.
- **Fireworks AI** — managed **RFT** (GRPO) with reward-kit and a tight
  train→serve loop; fast open-model serving. Route for turnkey
  post-training-and-deploy.
- **Together AI** — broad AI-cloud: serverless + dedicated endpoints + **raw
  InfiniBand clusters** + Batch API. Route for cluster scale or standalone
  batch jobs.
- **Lilac (getlilac.com)** — cheap, fast, OpenAI-compatible inference on idle
  enterprise GPUs; hosts GLM 5.1 / Kimi K2.6 / Gemma 4 31B / MiniMax. Route as
  a low-cost generation probe only until batch/concurrency limits are verified.
  Not the Databricks "Lilac" data tool.

## Output Standard

A short plan the developer can audit:

- **Job**: type, N, D (or token volume), hardware.
- **Local**: wall-clock band, $0, and whether the time is tolerable.
- **Cloud**: wall-clock band, $ band, on which GPU/provider, with cited $/hr or
  $/token.
- **Recommendation**: local / cloud / hybrid; if cloud, the lead provider + the
  single deciding axis, plus one alternative, each strength cited to
  [`references/providers.md`](references/providers.md).
- **Assumptions & caveats**: every *assumed* input, MFU/throughput used,
  source+date of each price, any unverified fit assumption the developer must
  confirm, and the "verify live pricing" reminder.
- **Next**: the single number that would most change the answer if re-measured,
  or [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
  for an RL-training handoff packet.

## References

- [`references/cost-estimation.md`](references/cost-estimation.md) — cited GPU
  FLOPS, $/GPU-hour and $/token tables, MLX/Apple-Silicon throughput
  benchmarks, the 6ND + MFU derivation, the serverless-vs-rented crossover, and
  a worked RL-trajectory example. Its **Source freshness** table dates and
  source-types every outside-party number.
- [`references/providers.md`](references/providers.md) — per-provider detail:
  offerings, RL/fine-tuning support, batch/throughput, cited pricing, OSS
  footprint, route-to lines, and the verified/unverified flags, with its own
  Source freshness table.
