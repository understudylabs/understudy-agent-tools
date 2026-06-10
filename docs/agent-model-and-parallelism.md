# Agent Model & Parallelism

Which model the *agent itself* should run as, and how to spend parallelism,
based on the Claude Fable 5 & Claude Mythos 5 system card (June 2026). This is
about the coding agent's own reasoning and orchestration — not the user's
workload models (Gemma, Nemotron, etc.), which other docs cover.

The one-line version: **prefer Claude Fable 5, fan out independent work to
non-blocking subagents, save the parallelism for the hard slow tail, and keep
workers long-lived.**

## 1. Prefer Fable 5 for the agent

If the harness lets you pick (a model setting, a subagent `model` override, a
`/model` switch), prefer `claude-fable-5`. The system card's case:

- **#1 on FrontierCode (Diamond)** — 29.3% vs Claude Opus 4.8's 13.4% and
  GPT-5.5's 5.7% (all at xhigh effort). On the Main subset, 46.3% vs 34.3%.
- **Even at medium effort, Fable 5 outperforms every other model at any effort
  level** on FrontierCode. That is the cost story: a downshifted Fable subagent
  still beats a maxed-out anything-else.
- **95% SWE-bench Verified, 80% SWE-bench Pro, 72.9% CursorBench** (leading at
  every effort level from medium up).

Two Fable-specific surface facts to respect:

- **Adaptive thinking only.** `thinking: {type: "disabled"}` is a 400 on
  Fable 5 — omit the `thinking` param instead. Sampling params (`temperature`,
  `top_p`, `top_k`) are removed.
- **Safety fallback is normal.** Fable 5 ships with classifiers that can hand a
  trajectory off to Opus 4.8 mid-task in high-risk domains (on Terminal-Bench,
  20.9% of trials). If a cyber-adjacent step gets refused or degrades, that is
  the safeguard working — route around it, don't fight it.

## 2. Parallelize the way the model card measured

Section 8.15 of the system card benchmarks three multi-agent harnesses on
BrowseComp and ProgramBench (run on Mythos 5 — the same base model as Fable 5,
without the deployment safeguards). The findings translate directly into how an
agent here should orchestrate:

- **Multi-agent Pareto-dominates the score–latency frontier.** Every
  multi-agent variant beat the best single-agent one; async subagents hit the
  top BrowseComp score (93.3%), and teams of 3/5/10 agents ran 2.2×/2.7×/2.7×
  faster than a single agent. On ProgramBench a five-agent team scored +7.9pp
  with a 3.2× speedup. **Default to fanning out independent work** — parallel
  tool calls in one block, background tasks, concurrent subagents.
- **Don't block on the slowest worker.** Non-blocking harnesses (peer teams,
  async subagents) beat the blocking orchestrator on *both* latency and
  tokens. The latency cost of a synchronization barrier is each round gated by
  its slowest member. Spawn subagents async / in the background and keep
  working; collect results as they land. This is the same ordering rule as
  [`engagement-and-pacing.md`](engagement-and-pacing.md) §2, now with
  measurements behind it.
- **Spend the parallelism on the hard tail.** On easy problems the median
  per-problem speedup was 0.8× — coordination overhead eats the gain. On hard
  problems it rose to 1.6× per-problem and 4.4× summed. A quick read, a single
  grep, a one-file edit: do it directly. Fan out for the genuinely slow or
  wide work — baselines, sweeps, multi-file analysis, broad searches.
- **Keep workers long-lived.** The blocking harness's token penalty came from
  spawning a fresh subagent per subtask and re-paying context establishment
  every time. Continue an existing subagent (send it a follow-up) instead of
  respawning; give each worker a coherent stream of related subtasks.
- **More agents productively absorb more token budget.** Token usage rises
  with agent count alongside score — parallelism is a latency–cost trade, not
  a free lunch. Estimate and announce the cost before fanning out, per
  [`engagement-and-pacing.md`](engagement-and-pacing.md) §1.
- **Tune effort per role.** The card's multi-agent runs used max effort
  everywhere, but FrontierCode shows medium-effort Fable still leads the
  field. Orchestration and final synthesis deserve high/xhigh; scoped
  mechanical subtasks can run lower.

## 3. Verify before you report

The system card's own failure audit (§2.3.3) found the largest issue cluster
was **stating an unverified guess as fact** (41/886) — e.g. reporting a
production release healthy after checking one error signal out of many. The
repo-wide rule in [`engagement-and-pacing.md`](engagement-and-pacing.md)
("never claim a win without measured before/after evidence") is the antidote;
it applies doubly when results arrive from parallel subagents. Spot-check
worker claims that feed a decision, and prefer cheap direct verification over
trusting a summary.
