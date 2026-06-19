---
name: recursive-language-model
description: Use when a developer wants a small or local model to take over an agentic task a frontier model one-shots — "can a small model do this whole case", "the prompt is too big for the small model", "hill-climb the local model on this task". Decomposes the task into bounded, flat-context steps behind the same call contract; includes the training path.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Recursive language model (decomposition harness)

A methodology, not a library — the coding agent writes the loop to fit the
workload. Use it when a frontier model does a task in **one giant agentic prompt**
(many tool declarations + a context that compounds as raw tool results pile up)
that a smaller local model cannot. Instead of shrinking the model, change the
*harness*: have the small model solve the task as a sequence of small, bounded
steps, each with a deliberately flat context.

Crucially, the RLM wraps the small model **behind the incumbent's existing call
contract** — the workload's callers send the same request and get the same answer;
the decomposition happens *inside*. That makes the specialist a **drop-in
replacement** for the frontier generalist, not a rewrite of the system around it.

This composes two other skills: it needs
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) to know the
task, its steps, and the success criteria, and
[`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
so the small model has a real, scorable place to run the whole case.

## The two things that make the giant prompt fail for a small model

- **Fixed tool overhead.** The whole tool catalog is re-sent every turn, often the
  large majority of the prompt, for a turn that uses one tool. Fix: **per-step tool
  subsetting** — show the model only the one or few tools that step needs.
- **Compounding context.** Each raw tool result (some very large) is appended and
  re-sent on every later turn, so the same bytes are billed many times and the
  window fills. Fix: **summarize each result** into the few facts the task needs and
  carry only the summary forward — context stays small and roughly flat.

## Recipe

1. **Frame the loop.** State = the task + a short scratchpad of notes + the step
   number. Each step, give the model only: the task, the relevant tool subset, and
   the current scratchpad. Ask for exactly one next action (or "done").
2. **Subset the tools per step** from the workload's tool catalog — never the full
   surface. Pick by intent (the step's verb → its tool class).
3. **Run the action** against the simulated environment (so there are no live side
   effects and any tool call gets a result), then **summarize** the result into the
   scratchpad. The raw result must not re-enter the next prompt — summarizing well
   is where recall is won or lost; extract exactly the fields the gold needs.
4. **Recurse when a step is itself big.** A step may be "spawn a sub-loop on
   sub-task X" (mirroring the workload's own sub-agents) — a fresh small-context
   loop whose summary returns to the parent. This is the "recursive" in RLM.
5. **Stop** when the model writes its answer/observations or hits a step budget;
   score the final state with the environment's validator.

## Pattern: structured intermediate artifacts

When the task is long-horizon synthesis (drafting, analysis, multi-document
work) rather than tool routing, have the loop emit **explicit intermediate
artifacts** — a structured plan, an extracted-facts table, a checklist the
deliverable must satisfy — and make later steps consume only those artifacts,
not free-form scratchpad prose. Each artifact is checkable (schema, required
keys) at the step that produces it, so errors surface mid-loop instead of in
the final deliverable. The gap this closes is large: measured on an internal
long-horizon benchmark, 2026-06-03, a structured-artifact workflow scored
57/59 where a raw free-form RLM loop scored 3/59 with the same models.

## The orchestrator and the runner need not be the same model

The hardest sub-skill is the orchestration — planning the decomposition and authoring good
sub-steps. The high-*volume* work is the bounded execution (run the step, summarize the
result). These can run on **different models**: a capable model orchestrates (low call
count, where quality matters) while a **small local model runs the bounded steps** (high
call count, where cost lives). This "big orchestrator + small runner" split keeps planning
quality high and displaces the fan-out — usually a better cost shape than forcing one small
model to do both. Decide per band: if the small model's *orchestration* is the gap (bad
plans, no grounding), keep a capable orchestrator and make the small model the runner; if
only *execution* is the gap, the small model can be both under a tighter scaffold.

## What to measure (what's possible)

**Outcome:**

- **Decomposition factor** — small-model steps ÷ the teacher's steps to reach the
  same scored final state. 1 = one-shot parity; higher = more bounded passes per
  teacher call.
- **Recall / precision / policy** vs the frontier (from the env validator), and how
  they move as you improve summarization, tool subsetting, and step prompts —
  this is the hill-climbing loop.
- **Flat-context win** — peak context vs the teacher's compounding context, and the
  resulting cost/latency at parity.

**Process (where it breaks — diagnose, don't just score).** A small model that scores
near-zero usually is *not* failing to know it should decompose (the harness prompts that);
it decomposes *badly*. Outcome alone can't tell you which sub-skill to fix, so instrument
the trajectory:

- **grounding rate** — fraction of steps that actually read the prior result vs reasoning
  in a vacuum (the dominant small-model failure: it stops reading its own output).
- **think-vs-act ratio** — output spent deliberating vs taking the next action.
- **compaction** — does the scratchpad/working context stay bounded, or balloon turn over turn?
- **repetition** — does it loop / re-derive the same step?
- **sub-summary accuracy** — are the summaries it carries forward actually correct?

These pinpoint *which* band to fix — plan vs execute vs ground vs combine — and they double
as **dense per-step rewards** when you train (reward grounding/compaction/correct summaries,
not just the final pass/fail). Empirically, scaling the base model buys *grounding and
execution* but not *less over-thinking* — so part of any gap is capacity, part is scaffold;
the process profile tells you which.

Report the local model's reachable score, the decomposition factor, the process profile,
and the remaining gap — feeding the route decision
([`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)) and, only if
local rungs genuinely can't close it,
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).

## Training Path

When the RLM loop itself is the thing that must improve, follow
[`references/pedagogical-training.md`](references/pedagogical-training.md). It
turns the decomposition harness into a verifiers-style training surface,
separates privileged training context (`c`) from deploy-time input (`x`),
measures surprise concentration, explains how to read a live GRPO training
signal, and decides whether the next rung is local pedagogical SFT, on-policy
repair, pedagogical RL, or a hosted verifier handoff. That reference also covers
**harvesting cold-start SFT data from the big-orchestrator/small-runner split** — collect
*good* trajectories from a strong root, don't SFT on a weak model's failures.

## Safety Gates

- Run only against the simulated environment or live tools the user approved — never
  fire real side effects while exploring.
- Keep captured customer data local; summaries and fixtures must be synthetic before
  anything is shared or committed.

## References

- [`references/pedagogical-training.md`](references/pedagogical-training.md) — train the RLM policy (verifiers shape, baselines, concentration, training arms, reading the training signal).
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
- [`../ladder/SKILL.md`](../ladder/SKILL.md) — vibe-check the hill-climbed local model vs the frontier.
