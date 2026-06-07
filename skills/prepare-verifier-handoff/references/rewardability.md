# Rewardability preflight: don't pay RL prices for zero gradient

Loaded on demand from `SKILL.md`. This is an **implementable principle**, not a shipped script:
inspect the actual scored-rollout artifact in front of you and implement the check below against its
real schema. A generic, pre-written checker fails *open* on data it doesn't understand — which is the
one outcome a spend-gate must never produce.

## The invariant

GRPO computes advantages **within a group** of rollouts for the same prompt/task. If a group's rewards
are all equal, its advantage is zero and the policy never updates. So the question is not "is the mean
reward high" — it is **"do same-task rollouts vary?"** Two common ways they don't, same dead outcome:

- **Strict / binary reward** (e.g. `task_completed_correctly`, `strict_match`) is usually constant
  within a group for a not-yet-strong model — everything scores 0. Prefer a **dense** reward
  (`partial_credit`, argument-value match, set-F1 / Jaccard).
- **Cost-trap** (small model × hardest tasks) → ~0 across the board (flat) → constant groups again.
  Start on the **easiest task slice** with a dense reward.

## What to implement (against the real artifact)

Read the scored-rollout file (e.g. a `vf-eval --save-results` export), identify the reward field and
the **per-task grouping key** (rollouts of the same task share it), then compute the within-group
spread and report a verdict. Correctness criteria — get all of these right, because each is a way the
naive version is wrong:

1. **Verify the grouping is real before trusting it.** Confirm the chosen key actually partitions
   *multiple rollouts of the same task*. If every group has one row, or everything collapses into one
   group, or the group count is implausible for the file, the data **cannot** show diversity → verdict
   `inconclusive`, not `ready`. A wrong group key is the most likely operator error; treat degenerate
   grouping as a loud failure, never a pass.
2. **Count input integrity against you.** Unparseable lines and rows with a missing/non-numeric reward
   reduce validity — fold them into the denominator, don't silently drop them. Low integrity →
   `inconclusive`.
3. **Require an adequate sample.** A verdict from one or two groups is noise. Require enough
   *multi-rollout* groups (rule of thumb: on the order of ~8+) before emitting `ready`; otherwise
   `inconclusive`.
4. **Measure within-group spread.** Report the fraction of groups whose rewards are constant (max ≈ min).
   "Constant" includes constant-nonzero, not just flat-zero — both give zero advantage.
5. **Fail closed.** Emit `ready` only when grouping is credible, integrity is high, the sample is
   adequate, **and** the constant-group fraction is comfortably below a majority. Anything else is
   `not-ready` or `inconclusive` — never default to `ready` on uncertainty.

## Output

State: groups inspected, mean group size, constant-group fraction, reward range / distinct values
(flag if it looks binary), integrity (parse rate), and the verdict (`ready` / `not-ready` /
`inconclusive`) with the reason. If not `ready`, the fix is a denser reward, an easier task slice, or a
cheaper intervention (output-control → A/B → GEPA → distillation) — then re-measure. Do **not** route to
an RL handoff until `ready`.
