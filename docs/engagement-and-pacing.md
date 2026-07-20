# Engagement & Pacing

How an Understudy agent should *feel* to work with. The optimization loop has
genuinely slow steps — model downloads, baselines, sweeps — and a good agent
keeps the user oriented and engaged across that wall-clock instead of going dark.
Every skill in this repo should follow these rules; onboarding and the
`understudy` orchestrator enforce them.

The one-line version: **plan up front, background the slow thing first, then fill
the wait with fast interactive work — and always say how long things take before
you start them.**

## 1. Estimate before you start

Never kick off a long action silently. Say what it is, how long it should take,
and what it costs, *before* running it. The user decides with that in hand.

- "The operations baseline is 100 tasks. At ~3 min/task with 20 in parallel
  that's ~15–20 min wall-clock and ~$31 on Sonnet. I'll run it in the
  background."
- "Pulling Nemotron 3 Nano is a ~18 GB download — ~4 min on a fast connection.
  Starting it now."

If you don't know the rate, measure a small sample first (a 3-task smoke), report
the per-unit cost/time, then project the decision-sized run. Label projections
as projections. The smoke estimates throughput and spend; it is not a reason to
shrink the evidence plan or stop early.

## 1a. Recommend the outcome-sized plan

Optimize for resolving the developer's objective under their real constraints,
not for minimizing spend in isolation. Present the recommended plan first with
its expected outcome, wall-clock, spend envelope, and evidence it will produce.
When useful, show a cheaper diagnostic and a faster or higher-confidence option
beside it, but do not make the weakest option the default merely because it is
cheap.

One approval may cover a named, bounded batch or run plan. Do not interrupt for
permission before every call inside that envelope. Before exceeding it, explain
what the extra spend is expected to resolve and ask for the expansion. If the
current evidence cannot answer the question, recommend more data, a stronger
model, more compute, or a broader experiment plainly instead of hiding the
tradeoff behind cautious prose.

## 2. Background the slow thing — first

Long or blocking work goes to the background (a background bash task, a monitor,
or a sub-agent), and it goes there **before** the interactive part, so it runs
*during* the conversation, not after it.

The ordering rule: **if a step needs a long-running background task, start that
task before you do a batch of interactive steps.** Onboarding is the canonical
example — start the small-model download, *then* profile the machine and
interview the user while the bytes arrive. By the time the interview is done, the
model is cached.

- Use background tasks / monitors for downloads, baselines, sweeps, installs.
- Prefer non-blocking fan-out over a barrier that waits on the slowest worker —
  the measurements behind this (and which work is worth parallelizing at all)
  are in [`agent-model-and-parallelism.md`](agent-model-and-parallelism.md).
- Announce the ETA, then move on to interactive work — do not block the user
  watching a progress bar.
- Surface a notification when it lands; do not silently poll.

## 3. Fill the wall-clock with useful work

A running baseline is free thinking time. Use it. While a long task runs, do
analysis that will matter when it finishes, and show partial findings as they
land:

- **Cost-model the alternatives.** While the incumbent baseline runs, compute
  what the candidate models would cost at the user's real request volume (pull
  fresh per-token prices; label assumptions). The user sees the decision taking
  shape before the baseline even finishes.
- **Pull benchmark/spec context.** Look up the candidate models' published
  benchmarks, context windows, licenses, and local hardware fit (see
  [`open-model-spotlight.md`](open-model-spotlight.md)) so the comparison table
  is ready the moment scores arrive.
- **Prepare the next step.** Scaffold the evidence artifacts, draft the splits,
  write the claim-packet skeleton — anything that removes latency from the next
  turn.

Bring the profiling forward too: detect hardware and installed tooling early
(during the first download), not after.

## 4. Plan up front, then show progress

- Open multi-step work with a short, concrete plan — what runs, in what order,
  what's backgrounded, and where the decision points are. A tracked task list is
  good; it doubles as the "where are we" map.
- Tell the user **where they are in the loop** at each turn: capture → baseline →
  optimize/compare → validate → decide. Re-derive it from artifacts on disk
  (see the experiment contract in [`../skills/understudy/SKILL.md`](../skills/understudy/SKILL.md)),
  not from memory.
- Prefer many fast, visible actions over one long opaque one. Momentum keeps the
  user engaged.

## 5. Use AskUserQuestion well

- Ask only what you genuinely cannot infer from the repo, the machine, or
  sensible defaults — inspect first.
- Batch related decisions into one question set rather than drip-feeding.
- Frame the *consequence* of each option, and gate real spend / downloads /
  uploads behind an explicit choice.
- Don't use it to ask permission to keep going on work the user already asked
  for.

## 6. Meet the user where they are

Read [`~/.understudy/profile.json`](../skills/onboard/reference.md) and adapt:

- **Vocabulary** — match their level; expand jargon for newcomers, use it
  directly with practitioners.
- **Coaching depth** — explain the "why" for first-timers; stay terse for
  experts.
- **Opinion strength** — give newcomers one clear recommended path; offer
  experienced users the trade-offs and let them choose.

If there's no profile yet, run [`onboard`](../skills/onboard/SKILL.md) first.

## Anti-patterns

- Running a 20-minute job in the foreground while the user waits.
- Starting a long task without saying how long it takes or what it costs.
- Going silent during a background run instead of doing analysis.
- Doing the interactive interview *after* the download instead of during it.
- Re-asking for information already in the profile or already on disk.
- Treating the cheapest action as the recommendation without comparing expected
  progress, time-to-answer, and confidence.
- Stopping at a smoke test, weak model, or convenient cohort when the result
  cannot answer the user's question.
- Claiming a cost/latency/quality win without measured before/after evidence.
