---
name: compare-trajectories
description: Use when a developer needs to know HOW two model runs differ behaviorally on the same tasks — not just THAT one scores higher. Per-task, per-step trajectory diffing between two runs that classifies the capability gap as persistence/recovery, knowledge, or format/parsing, and counts warm-start examples. "why does the bigger model pass these", "is this gap RL-shaped", "diff these two trajectory runs", "where do the trajectories diverge", "what would distillation buy me". Complements compare-model-sweep (scalars) with behavior.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Compare Trajectories

Use this worker when
[`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) has already
told you *that* model A and model B score differently on a frozen eval, and the
next question — the one that decides whether to spend RL budget — is **HOW their
trajectories differ, step by step, on the same tasks.** A pass-rate delta is a
scalar; it cannot tell you whether the stronger model wins because it tries
longer, because it knew the right endpoint, or because the weaker model's
tool-calls were malformed. Those three answers point at three different fixes —
RL, retrieval/world-knowledge, or decoding/prompt — and only a per-task
trajectory diff separates them.

This skill aligns two (or more) run exports by task id, builds the outcome-delta
matrix, computes behavioral divergence on shared tasks, **classifies each
reachable-gap task**, and counts how many clean warm-start trajectories the
comparison yields. It reads trajectory JSON that already exists on disk; it does
not run models. To produce the trajectories, run
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) or
[`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) first.

## Safety Gates

- **Local-first, no upload.** Trajectory exports contain full message bodies and
  tool I/O. Keep the diff, the matrix, and the report under `.understudy/`; do not
  paste trajectories or task content into external services.
- **Flag small N.** A reachable-gap set of 3 tasks is an anecdote, not a
  capability claim. State the shared-task count and the per-class count on every
  verdict, and refuse to generalize below a stated floor (default N<10 →
  "directional only").
- **Segregate frozen holdout.** If either export includes holdout/frozen rows,
  say so and split the matrix into train/dev vs holdout sections — never
  warm-start from holdout trajectories, and never report a holdout-derived gap as
  a training signal. Prefer a hash-stamped selection from
  [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md).
- **No vibes.** "B is better" must be backed by the per-task matrix and the
  divergence metrics, never by reading a few transcripts. The gap classification
  is a **hypothesis to confirm**, not proof — label it as such.
- Make all token/cost/step claims from the export fields, not memory.

## Decision Gate

Use this skill when you need to know **WHY** two runs differ. If you only need the
scalar frontier (pass-rate, latency, cost, reliability) to pick a route, use
[`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) instead —
this skill is its behavioral complement, not a replacement. Both runs must come
from the **same frozen task set, harness, and tool-access mode**; if they don't,
stop — a trajectory diff across different tasks is meaningless.

## Flow

1. **Load two runs.** Take two run JSON exports (A = baseline/weaker, B =
   candidate/stronger by convention). Each has per-task records with
   `{id, name, score, passed, assertion_results, steps, messages (role +
   tool_calls), end_state, finish_reasons, input/output_tokens, cost}`. Validate
   both share a schema and a task-id space; record the export paths, model ids,
   and harness/tool-access mode. More than two runs → run pairwise vs the chosen
   baseline. See `examples/traj_diff.py`.

2. **Align by task id.** Inner-join on `id`. Report the shared-task count, any ids
   present in only one run (and why — crash, timeout, missing), and which ids
   carry a holdout/frozen flag. Drop unmatched ids from divergence math; list them.

3. **Build the outcome-delta matrix.** Cross-tabulate `passed`: A✓B✓ (both pass),
   A✗B✗ (both fail), **A✗B✓ (the reachable-gap set — what B unlocks)**, and A✓B✗
   (regressions — what B loses). Emit agreement count, disagreement count, and the
   two named id lists. The reachable-gap set is the input to steps 5–6.

4. **Behavioral divergence on shared tasks.** Per shared task, compute from the
   trajectories: steps-to-done (both); `finish_reasons` distribution bucketed to
   {completed, max_steps, gave_up, error}; distinct tool calls / endpoints
   attempted; recovery-after-error events (did it retry after a 404 / empty result
   / error, or quit the next step?); and **first-divergence step** — the first
   step index where the two trajectories' tool-call sequences stop matching.
   Summarize as distributions, not raw transcripts.

5. **Classify the gap.** For each reachable-gap task (A✗B✓), label the gap as:
   - **persistence/recovery** — B reached the same tools/endpoints A did but A
     stopped early (gave_up / fewer steps / no retry after error) while B retried
     and recovered. **RL-learnable** — the policy can be trained to try longer.
   - **knowledge** — B called a correct endpoint/tool A never attempted at all.
     **Not RL-addable** — RL won't inject world knowledge; needs retrieval, a tool
     hint, or a stronger base.
   - **format/parsing** — A's failure is malformed tool-calls / schema-invalid
     args / unparseable output, not a strategy gap. **Fixable by prompt/decoding**,
     not RL.
   Emit the per-class breakdown and per-task evidence (which signal fired). Treat
   the label as a hypothesis; spot-check a redacted sample per class to confirm.

6. **Warm-start yield.** Count the A✗B✓ tasks where B's passing trajectory is
   **clean** (passed, no error-recovery thrash beyond a threshold, valid
   tool-calls, terminated `completed`). These are high-quality distillation /
   warm-start examples — feed them to
   [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md).
   Exclude any holdout-flagged tasks from the yield count.

7. **Report.** Write the matrix, divergence summary, gap-class breakdown,
   warm-start count, and the RL-shaped verdict to
   `.understudy/trajectory-diffs/<timestamp>/`.

## Output Standard

End with the diff path and: the two run ids + harness/tool-access mode;
shared-task count and N caveat; the outcome matrix (A✓B✓ / A✗B✗ / **A✗B✓
reachable-gap** / A✓B✗ regressions) with named id lists; the behavioral
divergence summary (steps-to-done, finish-reason buckets, recovery events, median
first-divergence step); the **gap-class breakdown** (persistence/recovery vs
knowledge vs format/parsing over the reachable-gap set); the **warm-start yield**
(clean B-passes of A-failures); and an explicit **"is this gap RL-shaped?"
verdict** — RL-shaped when persistence/recovery dominates, *not* RL-shaped when
knowledge or format dominates — stated as a hypothesis with the N caveat and any
holdout segregation. If regressions (A✓B✗) exist, surface them; a stronger model
that loses tasks is not strictly better.

## References

- [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) — the
  scalar Pareto this skill complements; run it first for the frontier.
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) — produces
  the local-model trajectory exports this skill diffs.
- [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) — local-vs-frontier head-to-head
  that also produces paired runs to diff.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) — supplies
  hash-stamped, holdout-segregated selections to diff.
- [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) —
  consumes the warm-start yield (clean B-passes of A-failures).
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) — adjacent
  vocabulary for tool-class and step decomposition.
