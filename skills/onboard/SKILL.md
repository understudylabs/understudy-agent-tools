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

Run this after [`install-agent-adapter`](../install-agent-adapter/SKILL.md). It follows the
engagement doctrine in
[`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md):
**start the slow download first, then interview while it runs.** Detail —
profile schema, interview bank, tooling-detection table — is in
[`reference.md`](reference.md).

## Safety Gates

- **Download approval + size cap.** Name the exact model, quantization, and disk
  size, and get a quick yes before pulling weights. Default to the smallest
  verified American open model that gives a real onboarding win, and label it
  as a bootstrap model rather than a workload recommendation.
- **Local-first, no upload.** Profiling, interview answers, and the model run
  entirely on the machine. The profile is local; it holds preferences and
  detected tooling — never secrets, keys, or customer data.
- **Gated weights** (e.g. Gemma via Hugging Face) need license acceptance + an
  HF token; the Ollama path avoids this. Never print or commit a token.

## Intake

Returning user? If `~/.understudy/profile.json` exists, read it, greet them by
where they left off, confirm nothing major changed, and skip straight to the
work — do not re-run the full interview. Only first-timers get the full flow.

If the launch prompt came from `install.sh --lower-my-ant-bill`, treat the
primary goal as lowering Anthropic/Claude API spend. Still do the local-first
profile and quick proof, but keep the interview short and route the real work
to [`../lower-anthropic-bill/SKILL.md`](../lower-anthropic-bill/SKILL.md):
inventory Anthropic call sites, re-baseline tokenizer risk, audit cache hits,
and build an opportunity ledger before any code edits or provider calls.

## Flow

1. **Start the slow thing first (background).** Detect the model runtime
   (`mlx_vlm`, `mlx_lm`, `ollama`, `llama-server`, `lms`). On Apple Silicon, the
   opinionated first out-of-box target is the smallest verified Gemma 4 local
   Understudy: the **QAT-derived** `gemma-4-e2b-it-qat-mlx-vlm-understudy` —
   `google/gemma-4-E2B-it` QAT weights converted by Understudy to MLX 4-bit at
   `group_size=32` (matching Q4_0's block structure). The verified snapshot is
   stored at
   `https://models.understudylabs.com/session?model=gemma-4-e2b-it-qat-mlx-vlm-understudy`
   (R2 source:
   `r2://understudy-model-snapshots/models/google/gemma-4-e2b-it/mlx-vlm-0.6.2/qat-understudy-4bit-g32/`).
   It is about 3.6 GB on disk, runs at ~3.9 GB peak memory (~2.6x less than
   BF16), and is 4/4 certified (generation, OpenAI-compatible serving,
   logprobs, tool calls) at the prescribed decode. Announce the model, quantization, size,
   source, and ETA, get a quick yes, then route through
   [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md) and run
   the CLI snapshot pull:
   ```bash
   understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy
   ```
   This caches the first Understudy under
   `~/.understudy/models/gemma-4-e2b-it-qat-mlx-vlm-understudy` and logs progress/ETA under
   `~/.understudy/agent-tools/logs/`. If the MLX runtime is missing, the slow
   step is *install MLX + pull* — get one quick approval, then background it.
   Read `understudy models snapshots` before promising the pull. If the live
   catalog and bundled certified fallback disagree with the session endpoint,
   surface the mismatch and offer the CLI repair flow; do not silently install
   a vanilla or third-party model. Then immediately move on; do not watch the
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

5. **Write the profile and agent card.** Save `~/.understudy/profile.json` (schema in
   [`reference.md`](reference.md)): experience tier, detected tooling, hardware,
   goal, constraints, and the three meet-them-where-they-are dials — vocabulary,
   coaching depth, opinion strength. Append, don't overwrite, the `history` of
   workloads and decisions. For `~/.understudy/agent-card.json`, check whether
   the Understudy desktop app is running first (read the card's `app.running` /
   `app.pid`, or hit `app.base_url`): the app is the canonical local daemon and
   maintains the card itself — server endpoint, warm models, shutdown state.
   Only refresh the card yourself as a **fallback when the app isn't installed
   or running**, recording live runtime facts: the local model, endpoint,
   serving process, companion status, and the exact command or URL for talking
   to the local Understudy. If `~/.understudy/companion.json` points at a dead
   pid, clear it and record the stale pid in the card.

6. **Land the quick win: show the local Understudy exists.** Once the snapshot is
   cached, route through [`../ladder/SKILL.md`](../ladder/SKILL.md) and start the
   onboarding climb:
    ```bash
    understudy run -- uv run --with mlx-vlm --with mlx-lm python skills/ladder/serve.py
    ```
   Then open
   `http://localhost:8011/ladder.climb.html?task=sort-email&model=gemma-4-e2b`
   or prove it headlessly:
    ```bash
    curl -N 'http://localhost:8011/run?task=sort-email&model=gemma-4-e2b'
    ```
   The ladder server loads the cached QAT snapshot for `gemma-4-e2b`, streams a
   scored local run, and can optionally compare against the billed gateway lane.
   Record the live runtime facts — endpoint, `served_by`, model path, and
   follow-along URL — in the agent card (step 5). Briefly teach the idea: an
   open-weight model is downloadable weights you run yourself; local is free and
   ZDR-safe; you iterate small and local, then *graduate* to a larger model in
   the same family via the gateway when you need the quality.

7. **Profile the user's real workload.** The main path after the local proof is
   not a model duel. Ask the user for a codebase, trace folder, dataset, eval
   runner, prompt file, or app route. If they point at a project, route to
   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) first:
   inspect prompts in situ, trace the request/response path through code,
   summarize the dataset or trace distribution, name the real task, and confirm
   that understanding with the user before any optimization. If there is already
   a real captured environment, skip the toy sandbox. Only use
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   when there is no resettable real workload yet. If the stated goal is lowering
   an Anthropic bill, route to
   [`../lower-anthropic-bill/SKILL.md`](../lower-anthropic-bill/SKILL.md)
   instead of asking for a generic problem.

8. **Make head-to-head optional.** A frontier-vs-local comparison is useful when the
   user needs to feel the quality gap, calibrate taste, or get buy-in. It is a
   side quest, not the default evidence path. If the user wants it, follow the
   [`ladder`](../ladder/SKILL.md) VS lane and disclose that the frontier side is
   billed. Otherwise keep going through workload understanding, capture
   evidence, and local evaluation against the actual task slice.

9. **Route onward.** Hand to the [`understudy`](../understudy/SKILL.md)
   orchestrator for the improvement loop. In the normal first-run path, the next
   worker is [`understand-workload`](../understand-workload/SKILL.md): pick a
   real app, trace, prompt file, dataset, or eval and define the task before
   comparing or optimizing models. Use
   [`manage-local-models`](../manage-local-models/SKILL.md) only to grow and
   organize the local model library, and
   [`run-local-model-lab`](../run-local-model-lab/SKILL.md) only once there is a
   frozen real workload/eval to score.

Adapt everything to the profile: expand jargon and give first-timers one clear
recommended path; stay terse and offer trade-offs to practitioners.

## Output Standard

End with: runtime + model downloading (and ETA, or "cached"); hardware found and
what fits locally; inferred experience tier and the dials set; the profile path
written; the agent-card path refreshed; the quick-win result (local generation
shown or pending); and one recommended next skill/command.

## References

- [`reference.md`](reference.md) — profile schema, interview bank, tooling map,
  experience→coaching dials.
- [`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md) —
  the background-first, fill-the-wait doctrine.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) —
  Gemma 4 & Nemotron 3 picks and hardware fit.
