# RL-readiness matrix: which open models can you actually GRPO?

Loaded on demand from `SKILL.md`. A model you can *serve* is not necessarily a model you can
*train* on a multi-turn tool-calling environment. Choose by **trainer + renderer** support, not by
inference availability. Verify against upstream before quoting — status moves per release.

## Multi-turn GRPO support (≈ June 2026)

| Family / variant | GRPO trainer (e.g. prime-rl) | Multi-turn renderer | Smallest single-GPU GRPO | Notes |
|---|---|---|---|---|
| Gemma 4 (E2B…31B) | ✗ not merged (WIP only: sdpa, ≤16k, grad-norm issues) | ✗ none → lossy default renderer | — | Single-turn GRPO works via Unsloth (E2B ~9 GB, `fast_inference=False`); **multi-turn tool-calling RL not ready** |
| Nemotron 3 Nano-30B-A3B (MoE) | ✓ first-class (`nemotron_h`, needs `mamba-ssm`) | ✓ real multi-turn renderer | ~2×H100 (~63 GB BF16) | The on-thesis multi-turn-RL-ready cell |
| Nemotron 3 Nano-4B (dense) | ~ **verify** — dense may not ride the `nemotron_h` MoE stack | ~ verify | possibly 1×H100 | If supported, the cheapest on-thesis GRPO; confirm the trainer path before committing |
| Qwen 3 4B (reference, non-American) | ✓ first-class (blessed single-H100 LoRA example) | ✓ | 1×H100 | Use as a cheap pipeline-proof before committing an American model |

## Why the renderer column matters

Multi-turn RL re-renders the conversation each turn. A family without a dedicated renderer falls back
to a generic `apply_chat_template`, whose turn-boundary handling is unproven — tokens drift across
turns and the reward you train on is not the reward you measured. No renderer ⇒ do not run multi-turn
tool-calling GRPO on that family yet, even if the trainer "accepts" the weights.

## How to re-derive this for any model (the table is a dated snapshot)

The table above is a point-in-time read and will go stale. For a model not listed, or to verify a row,
determine readiness from primary sources rather than trusting the snapshot:

1. **Trainer support** — does the trainer (e.g. prime-rl) have *merged* modeling for the family
   (a `models/<family>/` impl or clean generic-HF support), not just an open WIP PR or an issue
   reporting grad-norm/registry breakage? Unmerged or buggy = not ready.
2. **Multi-turn renderer** — is there a dedicated renderer for the family (e.g. a `renderers/<family>`
   with a real `bridge_to_next_turn`), or only the generic default? No renderer ⇒ multi-turn unsafe.
3. **Smallest trainable variant vs your GPUs** — find the smallest variant the trainer actually
   supports and check it fits (weights + KV cache + a co-located inference process).
4. **Inference ≠ training** — day-0 serving support does not imply trainer support; check them
   separately.

A model passes only if 1 and 2 both hold for multi-turn; otherwise it is single-turn-only or not ready.

## Relationship to `rlm-pedagogical-training`

The "Reading the training signal" section of
[`rlm-pedagogical-training/SKILL.md`](../../rlm-pedagogical-training/SKILL.md)
applies the same trainer/model fit gate at training time (renderer + registry +
merged GRPO). This matrix is the canonical support table; when a family's
status changes, update both places together so the Gemma-4/Nemotron-3 finding
never forks.

## How to use this before a handoff

1. Find the candidate model's row. If trainer **or** renderer is ✗/verify for multi-turn, the RL
   handoff is not ready — pick a supported family, or drop to single-turn (see below).
2. Confirm rewardability and the cost-trap by implementing the check in
   [`rewardability.md`](rewardability.md) against the actual scored-rollout artifact before
   committing spend.
3. "Does this model GRPO at all" (single-turn cookbook) and "this model on a multi-turn env" are
   different tiers — a family can pass the first and fail the second.
