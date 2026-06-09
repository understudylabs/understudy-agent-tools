---
name: estimate-run-cost
description: Use when a developer asks how long an ML job will take and what it will cost — fine-tuning/SFT, RL training, batch inference, or RL trajectory generation — comparing local Apple-Silicon (MLX) against cloud GPU and serverless. Produces a wall-clock + dollar estimate and a local-vs-cloud recommendation before any spend. Pairs with choose-cloud-provider for where to run it.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Estimate Run Cost

Answer two questions before a developer spends anything: **how long will this run,
and what will it cost** — local (Apple Silicon / MLX) versus cloud (rented GPU or
serverless). The goal is a defensible back-of-envelope with explicit assumptions,
not a precise quote. Always show the inputs and the arithmetic so the estimate can
be checked and re-run when a number changes.

This skill estimates and recommends. It never provisions, rents, or spends — that
is always an explicit, separate user action. For *where* to run a job once the
numbers point to cloud, hand off to
[`choose-cloud-provider`](../choose-cloud-provider/SKILL.md).

## When to use

- "How long will fine-tuning / SFT / an RL run take on my Mac vs a rented GPU?"
- "What will it cost to generate N RL trajectories?" (policy rollouts at scale)
- "Is this cheaper to run locally or in the cloud?"
- Before any [`prepare-verifier-handoff`](../prepare-verifier-handoff/SKILL.md) or
  remote run, to size the spend.

Not for: choosing a model (see [`compare-model-sweep`](../compare-model-sweep/SKILL.md)),
or running the job itself.

## Safety Gates

- **Estimate only — never spend.** This skill does not rent GPUs, start jobs, or
  call paid APIs. Provisioning and spending are separate, explicit user actions.
- **Label every number.** Mark each input as *measured* (benchmarked on this
  machine / quoted from a live price page) or *assumed* (rule-of-thumb). An
  estimate built on assumptions must say so.
- **Prefer a measured local datapoint** over a generic benchmark when the hardware
  is available: a 2-minute throughput probe (tokens/sec on the actual machine)
  beats a number from someone else's M-series. See `reference.md`.
- **No silent staleness.** Cloud prices and serverless rates drift; cite the source
  and date of every dollar figure, and flag when a cited number may be out of date.
- **Range, not false precision.** Report a low/high band, not a single number, and
  name the dominant uncertainty (usually MFU for training, throughput for rollouts).

## Inputs to gather

Ask only for what the job type needs:

- **Job type**: SFT/LoRA, full fine-tune, RL (GRPO/DPO), batch inference, or RL
  trajectory generation.
- **Model**: parameter count N and quant (sets memory + per-token compute).
- **Data size**: training tokens D (≈ examples × avg tokens × epochs), or for
  inference/rollouts: num_prompts × rollouts × avg output tokens.
- **Hardware on hand**: chip + unified memory (local), or target GPU (cloud). The
  Understudy profile at `~/.understudy/profile.json` often has the local machine.

## The estimate

Two engines, picked by job type. Full constants, benchmarks, and cited prices live
in [`reference.md`](reference.md); the methodology is here.

### Compute-bound work (training / fine-tuning)

1. **FLOPs** ≈ `6 × N × D` (forward+backward; the standard 6ND approximation —
   `reference.md` cites the origin). LoRA reduces the *trainable* params but the
   forward/backward still flows through the full model, so use full N for wall-clock.
2. **Wall-clock** ≈ `FLOPs / (GPU_peak_FLOPS × MFU)`. Use realized MFU ~0.3–0.5,
   not peak. State the GPU's BF16 dense FLOPS from `reference.md`.
3. **Local (MLX)** has no published MFU; instead use a measured tokens/sec from
   `mlx_lm.lora` (or the probe) and `wall-clock ≈ D / throughput`.
4. **Cost** = `wall-clock_hours × $/GPU-hour` (cloud) or **$0** (local, already-owned).

### Throughput-bound work (inference / RL trajectory generation)

1. **Total output tokens** = `num_prompts × rollouts × avg_output_tokens` (+ input
   tokens if a per-token rate charges for them).
2. **Serverless** cost = `total_tokens × $/token` (from a provider price page). Fast
   to start, no idle cost, but per-token adds up at scale.
3. **Rented deployment** cost = `(total_tokens / sustained_throughput) × $/GPU-hour`.
   Wins above a crossover volume because you amortize a flat hourly rate. `reference.md`
   shows how to find the crossover.
4. **Local (MLX)** cost = **$0** but bounded by one machine's tokens/sec — fine for
   thousands of rollouts, slow for millions. Compute the wall-clock and let the
   developer judge if the time is acceptable.

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

### Decide

Present **local vs cloud side by side**: wall-clock and dollars for each, with the
band and the dominant assumption. Recommend local when it's free and the wall-clock
is tolerable; recommend cloud when local wall-clock is the blocker (typical for RL
training and large-scale rollouts — see the Understudy local-SFT / cloud-RL split).
When the answer is cloud, hand to [`choose-cloud-provider`](../choose-cloud-provider/SKILL.md).

## Output Standard

A short estimate block the developer can audit:

- **Job**: type, N, D (or token volume), hardware.
- **Local**: wall-clock band, $0, and whether the time is tolerable.
- **Cloud**: wall-clock band, $ band, on which GPU/provider, with cited $/hr or $/token.
- **Assumptions**: every *assumed* input, MFU/throughput used, and source+date of each price.
- **Recommendation**: local / cloud / hybrid, plus the single number that would
  most change the answer if re-measured.

## References

- [`reference.md`](reference.md) — cited GPU FLOPS, $/GPU-hour and $/token tables,
  MLX/Apple-Silicon throughput benchmarks, the 6ND + MFU derivation, the
  serverless-vs-rented crossover, and a worked RL-trajectory example. Its **Source
  freshness** table dates and source-types every outside-party number so an agent can
  re-verify and flag stale docs.
- [`choose-cloud-provider`](../choose-cloud-provider/SKILL.md) — where to run cloud work.
