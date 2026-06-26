---
name: manage-local-models
description: Use to acquire, cache, organize, and explain local open-weight models — "download a model", "what models do I have", "where did the weights go", "free up model disk", "which Gemma/Nemotron should I pull", "how do open models work". Covers where weights come from and live, formats/quantization, gated weights and HF tokens, disk budgeting, start-small-and-cache, and the local→cloud graduation path. American families (Gemma 4, Nemotron 3). To score a local model on a workload, use run-local-model-lab.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Manage Local Models

Get open-weight models onto the machine, keep them organized, and teach the user
enough to choose well. This skill is acquisition + curation + education; to score
a local model against a workload, use
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md).

The habit this skill installs: **start with the smallest model that could work,
cache it, prove the loop, and only step up when an eval says you must.** Small
local models are free, private, and instant to iterate on; big quality lives one
`understudy` route away when you actually need it.

## Safety Gates

- **No download without explicit approval + a size cap.** Always state model,
  quantization, and GB on disk first, then confirm. Weights are large; a wrong
  pull can fill a disk.
- **Background big pulls.** Announce the ETA, start the download in the
  background, and keep working — do not block the user on a progress bar.
- **Gated weights need consent.** Gemma (and some others) require accepting a
  license and using a Hugging Face token. Walk the user through acceptance; never
  print, log, or commit the token. The Ollama path serves Gemma without an HF
  token.
- **Local-first, no upload.** Pulling weights is a download only; nothing about
  the user's data leaves the machine.
- Make size/spec/price claims from fresh official sources (HF model cards, the
  Ollama library, vendor pages), never from memory — label anything indicative.

## Intake

Read `~/.understudy/profile.json` for hardware, installed runtimes, and the
user's experience tier (set tone accordingly). Inventory what is already cached
before proposing a download — the best pull is often one they already have. Disk
locations and registry links are in [`reference.md`](reference.md).

## Flow

1. **Inventory.** List installed runtimes and already-cached models, and report
   free disk. (`ollama list`; Hugging Face cache scan; MLX/LM Studio dirs — see
   [`reference.md`](reference.md).) Surface total disk used by weights.
2. **Pick the smallest viable American model.** For onboarding on Apple Silicon,
   be prescriptive: start with Understudy's verified
   `google/gemma-4-e2b-it` MLX-VLM 4-bit snapshot, then climb only when the
   head-to-head or eval says the rung is too weak. Match later goals and
   hardware to a tier, biased small (full ladder + hardware rule-of-thumb in
   [`reference.md`](reference.md) and
   [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md)):
   - **Gemma 4** (Google) — verified E2B first; E4B/12B to climb; 26B-MoE / 31B
     dense for workstation or remote routes. Strong small-to-mid, multimodal.
   - **Nemotron 3** (NVIDIA) — Nano 4B as an alternate edge rung; Nano 30B-A3B
     (MoE, ~4B-active speed) or Super on big-RAM boxes. Agentic-reasoning, long
     context.
3. **Choose source + format for the runtime.** Ollama library (simplest, GGUF,
   no HF token for Gemma); Hugging Face GGUF (llama.cpp / LM Studio); MLX builds
   (Apple Silicon). Quantization/format primer in [`reference.md`](reference.md).
4. **Confirm the size, then use the CLI pull command.** For the Understudy
   verified MLX ladder, use the product command after approval:
   ```bash
   understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy
   ```
   Use `--dry-run` first when you need to show destination/log paths without
   downloading:
   ```bash
   understudy models pull gemma-4-e2b-it-qat-mlx-vlm-understudy --dry-run
   ```
   To cache every verified snapshot currently listed in the CLI catalog, use:
   ```bash
   understudy models pull --all
   ```
   The command downloads signed per-file URLs from
   `models.understudylabs.com`, writes into `~/.understudy/models`, verifies
   sizes and hashes when present, and logs progress/ETA to
   `~/.understudy/agent-tools/logs/model-pull-*.log`. For non-Understudy
   sources, use the native runtime pull (`ollama pull`, `hf download`, LM
   Studio) and keep the same approval boundary.
5. **Serve from the manifest, not from memory.** Each verified artifact ships an
   `understudy.serving.json` (see [`references/serving-manifest.md`](references/serving-manifest.md))
   encoding the exact launcher, required flags, and prescribed decode. Emit the
   correct serve command with the helper rather than hand-specifying flags:
   ```bash
   node scripts/serve-understudy-snapshot.mjs --model gemma-4-e2b-it-qat-mlx-vlm-understudy        # print the exact command
   node scripts/serve-understudy-snapshot.mjs --model gemma-4-e2b-it-qat-mlx-vlm-understudy --exec  # spawn it
   ```
   This is what prevents the recurring config mistakes: a forgotten
   `--top-logprobs-k 20` (mlx_vlm defaults it to 0 and silently gates
   `top_logprobs`), the wrong sampling (greedy is off-spec for `do_sample: true`
   models), or a mis-wired MTP draft.
6. **Verify + record.** Once cached, run a one-line generation to confirm it
   loads and does tool calls if the workload needs them. Append the model to
   `local_models` in the profile (id, runtime, quant, size, date).

   **Also pre-research and record the recommended serving settings, at pull
   time, not at bench time.** Read the snapshot's `understudy.serving.json`
   (preferred — it is the machine-readable source of truth) or, if absent,
   `generation_config.json` (sampling: `do_sample`, `temperature`,
   `top_p`/`top_k`, schedules) and the model card's serving guidance, and record
   them alongside the model entry in the profile (e.g.
   `serving: {temperature: 1.0, top_k: 64, top_p: 0.95}`). Local servers are not
   neutral: MLX servers map an omitted temperature to 0 (greedy), which is
   off-spec for every `do_sample: true` model and breaks diffusion LMs outright.
   The pre-researched ladder settings live in
   [`reference.md`](reference.md) — check there before serving anything from
   the verified ladder.
6. **Curate.** Offer to remove superseded or oversized weights to reclaim disk;
   show how to relocate the cache to another volume if space is tight
   ([`reference.md`](reference.md)).
7. **Point at graduation.** When a local model is good but not quite enough, the
   path is *same family, larger, remote* via
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
   prompts and behavior carry over. Evaluate the gap with
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md).

For first-timers, teach as you go: what an open-weight model is, why local is
free and private, what quantization trades away, and why MoE "30B but 3B active"
runs fast. For practitioners, skip it and just name the pick. If the user is
hitting tool-call fidelity problems after quantization (broken JSON, model
stops calling tools), route to
[`../optimize-local-model-compression/SKILL.md`](../optimize-local-model-compression/SKILL.md)
for the layer-aware compression method and the QAT group-size fix.

## Output Standard

End with: runtimes + models already cached and disk used; the recommended pull
(model, quant, GB, source link) and why that tier; download status (backgrounded
+ ETA, or cached); profile updated; any approval still pending (gated-weight
license/token, large download); and one recommended next skill/command.

## References

- [`reference.md`](reference.md) — download locations, registry links, format &
  quantization primer, gated-weights/token, disk budgeting & relocation.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) —
  Gemma 4 & Nemotron 3 variants, benchmarks, and hardware fit.
- [`../optimize-local-model-compression/SKILL.md`](../optimize-local-model-compression/SKILL.md)
  — layer-aware compression for tool-calling workloads (the QAT group-size
  fix, outcome-optimized calibration, and the stacked method).
