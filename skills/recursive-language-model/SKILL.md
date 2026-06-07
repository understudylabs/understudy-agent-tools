---
name: recursive-language-model
description: Use to make a small/local model take over an agentic task a frontier model one-shots, by decomposing it into bounded steps with flat context (a recursive-language-model loop) and measuring what's possible — "can a small model do this whole case", "decompose this workload for a local model", "the prompt is too big for the small model", "hill-climb the local model on this task", or any handoff from understand-workload + design-simulated-environment toward whole-case local takeover.
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

## What to measure (what's possible)

- **Decomposition factor** — small-model steps ÷ the teacher's steps to reach the
  same scored final state. 1 = one-shot parity; higher = more bounded passes per
  teacher call.
- **Recall / precision / policy** vs the frontier (from the env validator), and how
  they move as you improve summarization, tool subsetting, and step prompts —
  this is the hill-climbing loop.
- **Flat-context win** — peak context vs the teacher's compounding context, and the
  resulting cost/latency at parity.

Report the local model's reachable score, the decomposition factor, and the
remaining gap — feeding the route decision
([`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)) and, only if
local rungs genuinely can't close it,
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).

## Training Path

When the RLM loop itself is the thing that must improve, route to
[`../rlm-pedagogical-training/SKILL.md`](../rlm-pedagogical-training/SKILL.md).
That worker turns the decomposition harness into a verifiers-style training
surface, separates privileged training context from deploy-time input, and
decides whether the next rung is local pedagogical SFT, on-policy repair,
pedagogical RL, or a hosted verifier handoff.

Do not assume RLM is better because a task is agentic. Run a flat local baseline
on the same sealed rows first. If the task is a bounded classification,
selection, extraction, or short JSON output and flat local wins on quality,
format, and latency, keep the flat route and use RLM only after a real
state/context bottleneck appears.

## Safety Gates

- Run only against the simulated environment or live tools the user approved — never
  fire real side effects while exploring.
- Keep captured customer data local; summaries and fixtures must be synthetic before
  anything is shared or committed.

## References

- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
- [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
- [`../rlm-pedagogical-training/SKILL.md`](../rlm-pedagogical-training/SKILL.md)
- [`../mlx-arena/SKILL.md`](../mlx-arena/SKILL.md) — vibe-check the hill-climbed local model vs the frontier.
