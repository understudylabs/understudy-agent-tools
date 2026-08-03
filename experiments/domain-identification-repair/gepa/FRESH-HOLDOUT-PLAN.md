# Fresh-holdout plan (domain-identification meet/beat)

## Why this is needed

The existing frozen holdout (digest retained privately, 16 tasks)
has **already been executed** in this session's fresh-baseline phase:

- incumbent `gpt-4o` holdout = 0.906
- `nemotron-3-nano-base` holdout = 0.313

So it is **observed/contaminated**. It is still valid as a *labeled
already-observed confirmation set*, but it can no longer serve as a sealed,
never-seen holdout for a promotion decision. A final meet/beat claim must rest
on evidence that was not used during configuration selection.

> Status: **documented only.** Do NOT construct or run any new holdout yet.
> This file proposes the smallest fix for approval first.

## Smallest fresh-holdout option (proposed)

Goal: a small, untouched, hash-bound split that no baseline or GEPA candidate
has ever seen, drawn from the same generator as the current fixture so the
scorer/contract are unchanged.

1. **Regenerate only new tasks.** Use the existing synthetic generator for
   `domain-identification-offline-v1` with a *new seed* to mint N fresh tasks
   per band (`direct-match`, `near-match`, `parent-join`, `abstain`), disjoint
   from the current train(24)/dev(8)/holdout(16) task_ids. Smallest useful
   size: **16 tasks, 4 per band** (mirrors current holdout shape).
2. **Freeze + hash-bind.** Compute `sha256` over the canonical serialization,
   register it as `domain-identification-holdout-v2`, and gate reads behind the
   exact-hash refusal already implemented in
   `src/domain-identification-slice.ts` (`frozenHoldoutSha256`).
3. **Seal.** Do not evaluate anything against v2 until a GEPA candidate is
   frozen and explicitly gated. Record `holdout_v2_executed=false` until then.
4. **Single-shot use.** Score the frozen candidate on v2 exactly once via the
   canonical `rollout.mjs` path; that number is the promotion evidence.

Fallback if regeneration is not desired: keep using the current 16-task holdout
strictly as a **clearly-labeled already-observed confirmation set** (never as
sealed evidence), and caveat every meet/beat statement accordingly.

## Contract invariants (unchanged)

- Deterministic outcome-first scorer; no LLM judge.
- Same serving contract / renderer / temperature / parser as baselines.
- Train tunable, dev = transfer measurement.
- Holdout (v2) sealed until the frozen-candidate gate.

## Decision needed

Approve (a) regenerate `holdout-v2` (16 tasks, 4/band, new seed) or (b) proceed
with the current holdout as a labeled already-observed confirmation set. No new
holdout will be built until this is chosen.
