---
name: onboard
description: Use as the engaging first-run experience right after the Understudy plugin is installed, or whenever a developer says "get started", "set me up", "I'm new to this", "onboard me", or asks what Understudy is and where to begin. Backgrounds a small open-model download while it profiles the machine, detects ML tooling, interviews the user to gauge experience and goals, and writes a durable ~/.understudy/profile.json so every later skill can meet the user where they are. Hands off to the understudy orchestrator.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Understudy Onboarding

The first thing a new user experiences. Goal: in a few minutes, leave them with
(1) a small open model **running locally on their own machine**, (2) a clear
sense of what Understudy is and why it matters, and (3) a saved profile so you
never re-ask what you already learned.

Run this after [`install-plugin`](../install-plugin/SKILL.md). It follows the
engagement doctrine in
[`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md):
**start the slow download first, then interview while it runs.** Detail —
profile schema, interview bank, tooling-detection table — is in
[`reference.md`](reference.md).

## Safety Gates

- **Download approval + size cap.** Name the exact model, quantization, and disk
  size, and get a quick yes before pulling weights. Default to the *smallest*
  American open model that gives a real win.
- **Local-first, no upload.** Profiling, interview answers, and the model run
  entirely on the machine. The profile is local; it holds preferences and
  detected tooling — never secrets, keys, or customer data.
- **Gated weights** (e.g. Gemma via Hugging Face) need license acceptance + an
  HF token; the Ollama path avoids this. Never print or commit a token.

## Intake

Returning user? If `~/.understudy/profile.json` exists, read it, greet them by
where they left off, confirm nothing major changed, and skip straight to the
work — do not re-run the full interview. Only first-timers get the full flow.

## Flow

1. **Start the slow thing first (background).** Detect the model runtime
   (`ollama`, `llama-server`, `mlx_lm`, `lms`). If one exists, announce the pick
   + size + ETA and **background** a pull of a small American model — Gemma 4 E4B
   or Nemotron 3 Nano (see [`open-model-spotlight.md`](../../docs/open-model-spotlight.md)).
   If no runtime exists, the slow step is *install a runtime + pull* — get one
   quick approval, then background it. Then immediately move on; do not watch the
   bar.

2. **Profile the machine (while it downloads).** Detect OS/chip (Apple Silicon
   vs CUDA), RAM / unified memory, free disk. State what fits locally. This is
   the hardware inventory from
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md), brought
   to the front.

3. **Detect ML tooling → infer experience.** Check for PyTorch, vLLM,
   Transformers, TRL/PEFT, MLX, llama.cpp, Ollama, the HF CLI, `nvidia-smi`
   (table in [`reference.md`](reference.md)). Lots of ML libs ⇒ experienced;
   none ⇒ likely first-timer. Use this to *pre-fill* the interview, not to
   skip it.

4. **Interview (one batched AskUserQuestion).** Confirm the inference rather than
   interrogate: *"I see PyTorch and vLLM here, so I'll assume you're comfortable
   with ML tooling — right?"* or *"No ML tooling yet — first time running models
   locally?"* Capture: experience tier, primary goal (cost / latency / quality /
   learning / compliance), hard constraints (ZDR / local-only / approved
   providers), and preferred coaching depth. Question bank in
   [`reference.md`](reference.md).

5. **Write the profile.** Save `~/.understudy/profile.json` (schema in
   [`reference.md`](reference.md)): experience tier, detected tooling, hardware,
   goal, constraints, and the three meet-them-where-they-are dials — vocabulary,
   coaching depth, opinion strength. Append, don't overwrite, the `history` of
   workloads and decisions.

6. **Land the quick win.** The model is cached by now — run one local generation
   so they see it answer **on their machine, $0, private**. Briefly teach the
   idea: an open-weight model is downloadable weights you run yourself; local is
   free and ZDR-safe; you iterate small and local, then *graduate* to a larger
   model in the same family via the gateway when you need the quality.

7. **Route onward.** Hand to the [`understudy`](../understudy/SKILL.md)
   orchestrator for the improvement loop;
   [`manage-local-models`](../manage-local-models/SKILL.md) to grow and organize
   the local model library; [`run-local-model-lab`](../run-local-model-lab/SKILL.md)
   to evaluate a local candidate against a real workload.

Adapt everything to the profile: expand jargon and give first-timers one clear
recommended path; stay terse and offer trade-offs to practitioners.

## Output Standard

End with: runtime + model downloading (and ETA, or "cached"); hardware found and
what fits locally; inferred experience tier and the dials set; the profile path
written; the quick-win result (local generation shown or pending); and one
recommended next skill/command.

## References

- [`reference.md`](reference.md) — profile schema, interview bank, tooling map,
  experience→coaching dials.
- [`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md) —
  the background-first, fill-the-wait doctrine.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) —
  Gemma 4 & Nemotron 3 picks and hardware fit.
