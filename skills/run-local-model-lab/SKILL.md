---
name: run-local-model-lab
description: Use when a developer wants to run a local or workstation-hosted model (e.g. a Gemma 4 variant via llama.cpp/MLX) against an existing Understudy workload/eval before spending on hosted providers or routing remote traffic — to inventory hardware, pick a model tier, measure quality/latency/cost locally, compare against remote, and produce a route decision (ship local, local-as-router, hybrid, or remote).
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Run Local Model Lab

Run a local model against an existing Understudy workload/eval to see whether it
is good enough before spending on hosted providers or routing remote traffic.
Local inference is $0, private, and the only legal path under ZDR / SOC2 /
local-only constraints — so it is the cheapest rung of the ladder. Same-family
models (e.g. local Gemma 4 → remote Gemma 4 31B via the gateway) graduate cleanly.

This skill measures and recommends; it does not download weights or change
production routing on its own.

## When to use

A workload already has (or can get) a frozen eval — see
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) — and the developer
wants a local candidate evaluated before remote spend, or needs a local-only
route for compliance. For pure remote inference/routing use
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

## Safety Gates

- **No weight downloads without explicit approval** and a stated size cap. Model
  weights are large; confirm the exact model + quantization + disk size first.
- **Local-first, no upload.** Keep traces, prompts, and outputs local unless the
  developer approves a specific upload. This is the compliant path — do not
  break it.
- **Gated weights** (Gemma, etc.) need license acceptance + an HF token; never
  print or commit the token.
- **Never evaluate an `-assistant` drafter on its own.** The `*-it-assistant`
  models are speculative-decoding drafters (MTP), not standalone models — they
  only speed up a paired target while preserving its quality. See
  [`reference.md`](reference.md).

## Flow

1. **Inventory hardware + runtime.** Detect OS/chip (Apple Silicon vs CUDA),
   RAM, and VRAM/unified memory; check installed runtimes (Ollama, llama.cpp, LM
   Studio, vLLM, Transformers, MLX). Recommend a runtime for the platform. Do not
   download anything yet. Surface what you found.
2. **Pick a candidate tier** (candidate chooser + hardware-fit guidance in [`reference.md`](reference.md)):
   - Tiny smoke — E2B / E4B class (fast, on-device; routing/triage/easy cases).
   - Real local eval — 12B class if hardware permits.
   - Workstation/server — 26B A4B (MoE, ~4B active so fast) or 31B dense.
   - Speculative-decoding path — a target model **plus its matching
     `-assistant` drafter** (a latency optimization, not a quality change).
3. **Freeze the workload contract.** Reuse the same eval rows, prompt, tool
   stubs, and scoring as the incumbent (the `capture-evidence` harness/metric/
   splits). Serve the local model behind an **OpenAI-compatible endpoint** (e.g.
   llama.cpp `llama-server` or MLX `mlx_lm.server` at `http://localhost:8080/v1`)
   and run the existing loop by pointing
   `base_url` at it — no harness rewrite. Write artifacts to
   `.understudy/local-model-lab/`, recording: model id, quantization, runtime,
   hardware, context length, latency, tokens/sec, and score.
4. **Compare against remote.** Score the local candidate vs the remote route
   (gateway / Lilac / frontier) on the objective:
   - Local wins if it is *good enough* and cheaper / faster / private.
   - Remote wins if the quality gap blocks shipping, or local ops cost exceeds
     provider spend at the real volume.
   - Hybrid if local handles triage / extraction / routing and remote handles
     the hard cases (cascade). Use
     [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
     for the remote side and to register the chosen route.
5. **Produce a route decision** — one of: *ship local*, *use local for replay
   only*, *use local as a router/triage tier*, *hybrid* (local for easy/private
   stages, remote for hard cases), *remote only*, or *escalate to a
   workstation/GPU*. Record cost/latency/quality tradeoffs and feed
   route-selection ([`../understudy/reference.md`](../understudy/reference.md)).

Make cost/availability/spec claims from fresh data (HF / official model cards /
the gateway catalog), never from memory — label assumptions.

## Output Standard

End with: hardware + runtime found; candidate tier(s) and why; the frozen
contract used; local vs remote scores with latency/cost/quality; the route
decision and its trigger to revisit; and any approval still needed (download,
upload, deploy). Fold results into the Understudy Agent Improvement Report
([`../understudy/reference.md`](../understudy/reference.md)).
