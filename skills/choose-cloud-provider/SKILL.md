---
name: choose-cloud-provider
description: Use when a developer needs to decide WHERE to run a hosted ML job — fine-tuning/SFT, RL training, batch inference, or RL trajectory generation — across providers like GCP, Prime Intellect, Fireworks, Together AI, and Lilac (getlilac). Maps the job shape to the provider whose strengths actually fit, with cited facts and honest caveats. Pairs with estimate-run-cost for how long and how much.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Choose Cloud Provider

A routing catalog: given a hosted ML job, point the developer at the provider whose
strengths fit the *shape* of the work. Providers overlap a lot (most serve open
weights over an OpenAI-compatible API at similar prices); the decision is usually
driven by one axis — managed-RFT vs raw clusters, cheap per-token rollouts vs
reserved throughput, or "I already have quota/credits here."

This skill recommends; it never provisions or spends. **Prices and features drift —
verify on the provider's live pricing page before any spend.** Every fact here
carries a source in [`reference.md`](reference.md). For *how long and how much* once
a provider is chosen, use [`estimate-run-cost`](../estimate-run-cost/SKILL.md); for
the local-first option that costs nothing, that skill covers it too.

## When to use

- "Where should I run this fine-tune / RL job / batch rollout?"
- "Who's cheapest/fastest for generating RL trajectories?"
- "I want managed GRPO vs I want to rent raw GPUs — who does which?"
- After [`estimate-run-cost`](../estimate-run-cost/SKILL.md) says the job belongs in
  the cloud, or alongside [`prepare-verifier-handoff`](../prepare-verifier-handoff/SKILL.md).

Not for: choosing a *model* ([`compare-model-sweep`](../compare-model-sweep/SKILL.md)),
or the authenticated Understudy gateway ([`use-understudy-gateway`](../use-understudy-gateway/SKILL.md)).

## Safety Gates

- **Route only — never provision or spend.** Renting GPUs, starting jobs, and
  entering payment details are explicit, separate user actions.
- **Verify live pricing before quoting.** Every dollar figure in `reference.md` has
  a source and a date; marketplace GPU prices fluctuate intraday. Re-check the page.
- **Factual and cited — no marketing.** Distinguish *verified* facts from *unverified*
  ones (flagged in `reference.md`). Vendor performance claims ("40X faster") are
  marketing until independently benchmarked; present them as such or not at all.
- **Honest caveats travel with the recommendation.** If a fit depends on an
  unverified capability (e.g. a provider's batch/concurrency limits for large rollout
  jobs), say so and tell the developer to confirm with the provider first.
- **No data-boundary advice by default.** If the workload has ZDR / residency / SOC2
  constraints, surface that the choice is constrained and defer to the developer —
  do not assume a provider's compliance posture.

## The routing decision

Match the job shape to the lead provider; `reference.md` has the full comparison.

| Job shape | Lead choice | Why (1-liner) | Alt |
|---|---|---|---|
| **Generate RL trajectories / cheap batch rollouts** of open-weight frontier models | **Together Batch** or **Fireworks RFT** | published batch/RFT paths and rate-limit posture | Lilac only after concurrency is confirmed |
| **RL training** (GRPO, multi-turn/agentic, reusable env) | **Prime Intellect** | `verifiers` env + `prime-rl` + Environments Hub + hosted Lab; scales 1→1000s GPUs | Fireworks if you want it fully managed |
| **Managed RFT** (reward fn → trained policy → served), least friction | **Fireworks** | self-serve GRPO RFT + reward-kit + one-click train→serve | — |
| **SFT / LoRA / DPO** then serve | **Fireworks or Together** | both do LoRA+full+DPO at ~$0.50/1M tok (≤16B), serve on same platform | — |
| **Raw GPU clusters** / run your own training/rollout engine at scale | **Together** (InfiniBand, up to 4,000+ GPUs) | bare-metal scale under one vendor | Prime Intellect marketplace (spot), or **Azure/GCP** if you hold quota/credits |
| **Serverless per-token inference** of open models | **Together / Fireworks / Lilac** | comparable OpenAI-compatible endpoints | — |
| **Hyperscaler** with existing quota/credits, Foundry/Vertex, data-residency | **Azure or GCP** | you manage the stack; good when already invested there | purpose-built RL/RFT providers |

A common pipeline: **generate rollouts through a published batch/RFT path (Together
Batch or Fireworks RFT) → train with Prime Intellect's verifiers + prime-rl**.
Lilac can be a cheap OpenAI-compatible probe path, but only promote it for large
rollouts after confirming concurrency and retry behavior with the provider.
Generation backend and training backend need not be the same vendor.

## Provider snapshots

One line each; full detail + citations in [`reference.md`](reference.md).

- **GCP** — hyperscaler raw GPU (A100/L4/H100 via Compute Engine + Vertex AI). Route
  when you already have quota, credits, or data-residency needs; you own the stack.
- **Azure / Microsoft Foundry** — hyperscaler GPU + managed model-customization path.
  Route when Microsoft credits/quota, Foundry/OpenAI integration, or Azure data-boundary
  requirements dominate; NCads H100 v5 fits training/batch inference and Foundry
  documents SFT/DPO/RFT support by model.
- **Prime Intellect** — the open RL stack (`verifiers`, `prime-rl`, Environments Hub,
  hosted **Lab**) on a GPU marketplace (H100 ~$2.43/hr on-demand, ~$0.94 spot).
  Route for RL training you want to author once and scale.
- **Fireworks AI** — managed **RFT** (GRPO) with reward-kit and a tight train→serve
  loop; fast open-model serving. Route for turnkey post-training-and-deploy.
- **Together AI** — broad AI-cloud: serverless + dedicated endpoints + **raw
  InfiniBand clusters** + Batch API. Route for cluster scale or standalone batch jobs.
- **Lilac (getlilac.com)** — cheap, fast, OpenAI-compatible inference on idle
  enterprise GPUs; hosts GLM 5.1 / Kimi K2.6 / Gemma 4 31B / MiniMax. Route as a
  low-cost generation probe only until batch/concurrency limits are verified. Not
  the Databricks "Lilac" data tool.

## Output Standard

- **Job shape**: type + model family + scale (token/rollout volume).
- **Recommendation**: lead provider + the single deciding axis, plus one alternative.
- **Cited basis**: the strengths that drove it, each with a `reference.md` source.
- **Caveats**: any unverified fit assumption the developer must confirm, and a "verify
  live pricing" reminder.
- **Next**: hand to [`estimate-run-cost`](../estimate-run-cost/SKILL.md) for the
  time/dollar estimate, or [`prepare-verifier-handoff`](../prepare-verifier-handoff/SKILL.md)
  for an RL-training handoff packet.

## References

- [`reference.md`](reference.md) — per-provider detail: offerings, RL/fine-tuning
  support, batch/throughput, cited pricing, OSS footprint, route-to lines, and the
  verified/unverified flags. Its **Source freshness** table dates and source-types every
  outside-party claim so an agent can re-verify and flag stale docs.
