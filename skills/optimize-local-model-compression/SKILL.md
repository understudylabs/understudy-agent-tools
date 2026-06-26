---
name: optimize-local-model-compression
description: Use when a developer needs to compress a local model for tool-calling workloads — "which quantization should I use", "why does my model emit broken JSON", "how do I get better tool-call fidelity from a 4-bit model", "OptiQ vs QAT vs naive", "the model stopped calling tools after quantization". Covers layer-aware sensitivity-driven compression, QAT group-size matching, and outcome-optimized calibration for structured output.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Optimize Local Model Compression

Compression (quantization to 4-bit) is mandatory for local deployment — it is
the difference between a 9.5 GB model and a 3.6 GB model, between 23 tok/s and
45 tok/s. But standard compression methods optimize for general text quality
(perplexity, MMLU) and **silently destroy tool-call fidelity**. This skill
teaches the method we invented to fix that: outcome-optimized, layer-aware
compression that protects the circuits responsible for structured output.

**This is not theory.** Every recommendation below is backed by measured
results on Gemma 4 E2B through 31B, on a 103-row tool-call benchmark and a
14-task multi-turn agent board, on Apple Silicon (M5 Max, 128 GB), at zero
API cost.

## When to use

- The user's compressed model emits broken JSON, fails to call tools, or
  scores lower on tool-calling tasks than the hosted version.
- The user is choosing between quantization methods (naive 4-bit, QAT,
  OptiQ, or a custom conversion).
- The user wants to convert a model and is asking which settings matter.
- A local eval shows a model "can't do tool calls" but the hosted version can.

## Safety Gates

- **No conversion without explicit approval.** Conversions are compute-heavy
  (15-30 min GPU time) and produce large artifacts. State the target model,
  BPW, and expected output size first.
- **Background long conversions.** Sensitivity probing takes 15-30 min;
  background it and keep working.
- **Do not run conversions during meetings.** GPU-bound work can freeze
  external monitors on Apple Silicon. Check for active display connections
  before starting.

## The three things that matter

### 1. Group size must match the training noise profile

If the model is a QAT checkpoint (Google's `q4_0` format), the downstream
quantization `group_size` **must** match the QAT block structure (32). The
default in most frameworks (MLX: 64, llama.cpp: varies) silently breaks QAT's
training-time hardening.

| Setting | Group size | Tool-name accuracy | Errors |
|---|---|---|---|
| QAT g64 (broken) | 64 (default) | 0.369 | 19 |
| **QAT g32 (correct)** | **32 (matched)** | **0.379** | **8** |

At E4B scale the damage is worse: g64 scores 0.155 (64 errors) vs g32 at 0.252
(37 errors) — a 10pp swing from one parameter.

**How to check:** read the model's `config.json` for `quantization_config` or
the QAT format spec. Google's Q4_0 uses block-32. Set `--group-size 32` on
every MLX conversion of a QAT checkpoint.

### 2. Calibration data determines which layers are protected

Sensitivity-driven compression (OptiQ, AWQ) measures per-layer vulnerability
by pushing calibration data through the model. **What you calibrate on is what
you protect.** The industry default (OptiQ's 6-domain mix) uses only 17%
tool-calling samples — it protects reasoning circuits, not tool-call circuits.

Using a calibration mix with 58% tool-calling traces changes the layer
allocation: 113 of 276 weight tensors receive a different bit-width assignment.
The layers that "wake up" as sensitive under tool-call data are concentrated in
early layers (1-8) — these control the tool-call trigger circuit.

| Calibration | Tool weight | Tool-name accuracy | Errors |
|---|---|---|---|
| OptiQ default (6-domain) | 17% | 0.350 | 17 |
| **Ours (tool-heavy)** | **58%** | **0.398** | **12** |

Same base model, same group size, same target BPW (5.0). Only variable is
calibration data. +4.8pp from calibration alone.

### 3. Stacking all three optimizations beats any single method

QAT hardening, sensitivity allocation, and tool-call calibration are
complementary, not alternative. Stacking all three produces the best artifact:

| Method | Size | Tool acc | tok/s | On Pareto frontier? |
|---|---|---|---|---|
| Naive 4-bit | 3.3 GB | 0.340 | 22.3 | ✅ (cheapest) |
| OptiQ default | 4.9 GB | 0.350 | 22.9 | ❌ dominated |
| QAT g32 | 3.6 GB | 0.379 | 23.5 | ✅ |
| **Stacked (QAT + g32 + tool cal)** | **4.3 GB** | **0.398** | **45.4** | ✅ |
| Vanilla BF16 | 9.5 GB | 0.408 | 23.2 | ✅ (highest quality) |

The stacked method recovers **98% of uncompressed BF16 fidelity at less than
half the size, and is 2× faster** than every other variant including BF16.

## How compression breaks tool calls (the error taxonomy)

Three distinct failure modes, each with a different root cause:

### Trigger failure (model emits prose instead of a tool call)

The dominant failure mode. The model writes natural-language reasoning
("I will now update the CRM record...") instead of emitting a tool-call
token. This is **not** garbled JSON — the model understands the task but
fails to switch into tool-emission mode.

- **Naive 4-bit:** 72.8% of rows fail this way (catastrophic)
- **QAT BF16:** 7.8% (QAT training specifically protects this circuit)
- **Vanilla BF16:** 16.5% (the base rate)

Compression degrades the gating mechanism that routes the model into
tool-call format. QAT hardening protects it; naive 4-bit destroys it.

### Parse failure (model attempts tool call but output is unparseable)

The model tries to emit a tool call but the structured output is malformed.
Rate scales with compression aggressiveness:

- **BF16:** 2.9-4.9%
- **Stacked (ours):** 10.7%
- **OptiQ default:** 11.7%
- **QAT g64 (broken):** 16.5%

### Wrong tool (model calls the wrong function)

The model emits a valid tool call but picks the wrong tool (e.g.,
`api_fetch` instead of `api_search`). This is roughly constant across all
compression levels including BF16 (~30-47%). **This is a model capability
ceiling, not a compression artifact.** No compression optimization can fix it.

## Flow

1. **Diagnose the failure mode.** Is the model failing to call tools
   (trigger failure), emitting broken JSON (parse failure), or calling the
   wrong tool (capability ceiling)? Each has a different fix:
   - Trigger failure → use QAT base + tool-heavy calibration
   - Parse failure → use lower BPW target (5.0, not 4.0) + tool-heavy calibration
   - Wrong tool → upgrade to a larger model; compression can't fix this
2. **Check the group size.** If using a QAT checkpoint, verify
   `group_size=32` in the conversion. See [`reference.md`](reference.md) for
   the per-model conversion commands.
3. **Choose the conversion method** based on model size and workload:
   - **E2B (onboarding):** Stacked (QAT + g32 + tool calibration). Best in class.
   - **E4B-12B (mid-range):** OptiQ pre-built or stacked conversion.
   - **26B+ (workstation):** OptiQ or naive; the NTC metric is less reliable here.
4. **Convert and certify.** Run the conversion, serve it, and verify tool-call
   fidelity with a scored eval. See [`reference.md`](reference.md) for the
   exact commands and the certification checklist.
5. **Record the artifact.** The compressed model should be named with its
   method (`-stacked-understudy`, `-qat-g32-understudy`, etc.) and logged
   with its BPW, group size, calibration mix, and measured fidelity.

## Conversion commands

See [`reference.md`](reference.md) for the exact `optiq convert` and
`mlx_vlm convert` commands, the calibration data format, the BPW
recommendations per model size, and the certification checklist.

## Output Standard

End with: the diagnosed failure mode; the recommended conversion method and
why; the conversion command (stated, not yet run without approval); the
expected fidelity vs the current artifact; and any approval still needed
(model download, compute time, disk space).

## References

- [`reference.md`](reference.md) — conversion commands, calibration data
  format, BPW table, certification checklist, and the full experimental
  evidence table.
- [`../manage-local-models/reference.md`](../manage-local-models/reference.md)
  — the verified MLX ladder, serving manifests, and quantization primer.
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) —
  how to score a compressed model against a real workload.
