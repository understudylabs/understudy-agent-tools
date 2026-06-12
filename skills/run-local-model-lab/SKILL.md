---
name: run-local-model-lab
description: Use when a developer wants to stand up and run a local model on Apple Silicon against their real workload — "run this model on my Mac", "is a local model good enough before I pay for hosted". Covers the MLX serving rig, a blind local-vs-frontier arena, and the route decision. For comparing many candidate models on one eval, use compare-model-sweep.
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

**Apple Silicon + MLX only.** On Macs, MLX is the native local path — quantized
open weights against unified memory at the best tokens/sec, no GPU drivers, no
build step. This skill standardizes on **`mlx_lm.server`** (an OpenAI-compatible
endpoint, one model per port); it does not use Ollama or llama.cpp.

**Want to *meet* the model, not just score it?** The blind-arena + hill-climb
protocol in [`references/blind-arena.md`](references/blind-arena.md) opens a
local model in Pi, runs a blind frontier-vs-local head-to-head (or two local
models side by side), and routes the hill climb from the observed gap — use it
for the first-run experience and taste calibration before or alongside the
scored lab runs here.

This skill measures and recommends; it does not download weights or change
production routing on its own. To compare several candidate models (any mix of
local, gateway, frontier) on one frozen eval, use
[`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md).

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

1. **Inventory hardware + runtime.** Confirm Apple Silicon (M-series) and the
   unified memory / free disk available. Set up the MLX runtime once with `uv`:
   `uv venv .understudy/venvs/mlx && uv pip install --python
   .understudy/venvs/mlx/bin/python 'mlx-lm>=0.31' 'huggingface_hub[cli]>=0.27'`.
   Do not download weights yet. Surface what you found. (Not on Apple Silicon?
   This skill does not apply — local serving here is MLX-only.)
2. **Pick a candidate tier** (candidate chooser + hardware-fit guidance in [`reference.md`](reference.md)):
   choose the smallest model that is reasonable for the task, not the smallest
   model available. If a Pi arena gap report already exists, use it to decide
   whether to score the current rung, climb to a larger local model, or skip to
   hybrid/remote.
   - Tiny smoke — E2B / E4B class (fast, on-device; routing/triage/easy cases).
   - Real local eval — 12B class if hardware permits.
   - Workstation/server — 26B A4B (MoE, ~4B active so fast) or 31B dense.
   - Speculative-decoding path — a target model **plus its matching
     `-assistant` drafter** (a latency optimization, not a quality change).
3. **Freeze the workload contract.** Reuse the same eval rows, prompt, tool
   stubs, and scoring as the incumbent (the `capture-evidence` harness/metric/
   splits). Serve the local model behind MLX's **OpenAI-compatible endpoint**
   (`mlx_lm.server --model <mlx-community/repo> --port 8080`, serving
   `http://localhost:8080/v1`) and run the existing loop by pointing
   `base_url` at it — no harness rewrite. Add `--trust-remote-code` for custom
   architectures (e.g. Nemotron-H). Write artifacts to
   `.understudy/local-model-lab/`, recording: model id, quantization, runtime
   (mlx_lm version), hardware, context length, latency, tokens/sec, and score.
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
