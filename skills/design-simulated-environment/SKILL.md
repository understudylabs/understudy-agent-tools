---
name: design-simulated-environment
description: Use to build a simulated, seeded environment (AutomationBench / verifiers style) so any model can run a captured agentic workload end-to-end and be scored on final state — "simulate this workload's tools", "build a validator for these traces", "let a small model attempt the whole task", "score recall/precision against gold", or any handoff from understand-workload toward whole-case model comparison.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Design a simulated environment + validator

The coding agent writes this fresh for each workload — **every workload's tools,
state, and success criteria differ**, so this skill is the *recipe*, not a fixed
implementation. The goal: a deterministic, synthetic environment where **any
candidate model can run the whole agentic task** and be **scored on the final
state**, so you can compare frontier vs. local and hill-climb the local model.

## Default environment first

Before building a codebase-specific environment, every new local Understudy
should run in a tiny **default environment** so the user has an immediate,
repeatable baseline:

- **Task shape:** read a small synthetic inbox / ticket queue / project board,
  decide what matters, write one structured update, and avoid forbidden writes.
- **Tools:** `list_records`, `read_record`, `write_note`, `update_status`, and
  `finish`. All tools mutate in-memory JSON only.
- **Gold state:** the exact notes/statuses a correct run should produce, plus
  forbidden writes that must not occur.
- **Validator axes:** required-write recall, unnecessary-write precision, policy
  compliance, schema validity, recoverable errors, step count, latency, and cost.
- **Oracle:** a scripted correct trajectory must score 1.0 before any model is
  compared.

This default env is not the customer's app and must not be presented as proof
that local can replace the incumbent. It is the first-run calibration surface:
"my local model can act in a deterministic tool world, and I can compare it to a
frontier model." After that, inspect the repo/traces and build the
workload-specific environment below.

## Why simulate (the lesson that forces this)

A **recorded** replay (serve the teacher's captured tool_results back) only works
for a model that reproduces the teacher's *exact* tool path. A different or smaller
model takes its own reasonable trajectory and immediately "diverges" — there is no
recording for the tools it actually called. So recorded replay can't fairly test a
different brain. A **simulated** environment implements the tools against seeded
state, so every call returns a real (synthetic) result and the run is judged by
*what got written*, not by matching the teacher.

Build this only after [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)
has produced the workload's purpose, tool catalog, inputs/outputs, and the success
criteria (recall / precision / policy — not just cost/speed).

When production traces are the source, first run the generic foundry in
[`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md). Its machine proposal,
source DAG, and human review become the evidence-backed starting point for this
simulation. Customer names and workload-specific assumptions must never enter
the generic compiler or viewer.

## Safety Gates

- **Synthetic data only.** Seed the environment with invented entities. A small
  hand-written fixture may validate the mechanics, but a workload claim needs a
  scalable, decision-sized generated suite. Never embed customer transcripts,
  records, names, or IDs — the simulated env is committable precisely because
  it contains none.
- **No live side effects.** Tools mutate in-memory state, never real systems.
- Keep the captured customer traces local; use them only to *infer the shape* you
  simulate.

## Recipe

1. **Seed synthetic state.** For the default env, use the built-in synthetic
   inbox/ticket/project-board fixture. For a workload-specific env, generate
   enough records and tasks to cover common, rare, and high-consequence entity
   and action combinations. Keep individual cases readable while scaling the
   suite; follow the data-sufficiency rules in
   [`../capture-evidence/references/evaluation-evidence-gates.md`](../capture-evidence/references/evaluation-evidence-gates.md).
2. **Implement the tools by intent, leniently.** Group the real tool catalog into
   read / transform / write classes (from understand-workload). For each class,
   return a plausible result from the seeded state. Be tolerant of arg/name
   variants (e.g. accept a tool called with or without an `mcp__…` prefix) so a
   candidate's reasonable-but-different call still gets a useful answer.
3. **Define the gold + a validator.** Write the complete correct outcomes each
   task implies (the observations/records a perfect run would write), each with the
   keys/values that must appear. Score the candidate's *final written state* vs gold
   → recall, precision, and any policy checks. The validator is the metric, not the
   trajectory.
4. **Drive any model through the loop.** Present the task + the available tools +
   a short running scratchpad; take one tool call per step; execute it; append a
   *summary* of the result; stop when the model writes its answer or hits a step
   budget. The same driver runs the frontier and the local candidate.
5. **Sanity-check with a scripted oracle** (a fixed correct trajectory) — it must
   score 1.0, proving the env + validator are right before trusting model scores.
6. **Report** per model: recall / precision / policy, steps taken, peak context,
   cost, latency. Feed the gap into hill-climbing the local model
   ([`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md))
   and the route decision ([`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)).

## Validator quality gates

Two checks beyond the scripted oracle, before any model score is trusted:

- **Strict-vs-dense divergence.** Score every run with both the strict
  pass/fail and the partial-credit axes. When strict reads 0 while partial
  credit is high across many rows, the strict reward is underestimating real
  behavior — and as a training signal it would yield constant all-fail groups
  with no gradient. Measured on an internal synthetic workload, 2026-05-18
  (strict pass-rate materially under-read behavior on a multi-step workload).
- **Reward-hacking sentinels.** Plant runs the validator must reject: an
  empty/no-op trajectory, a plausible-but-wrong-values write, and a
  metric-gaming run (e.g. writing every record to inflate recall). Each must
  score near 0 — the precision and forbidden-write axes are what keep recall
  un-gameable. A validator that hasn't rejected a sentinel has not been
  tested.
- **The right-answer-wrong-contract sentinel.** A run whose *content* is
  correct but whose *shape* breaks the caller — the canonical case is the
  gold answer as valid JSON wrapped in markdown fences, which leaves an
  SDK's parsed `.object` undefined while every quality axis passes. Quality
  must stay high and a separate contract axis must read 0 — proving the
  validator separates "right answer" from "parseable in production"
  (implementation in the example env's `smoke.py`).

## Running it as a real `verifiers` env

One env, many uses: the *same* `verifiers` Environment serves eval, RL training,
synthetic-data generation, and agent-harness experimentation ("playgrounds for RL
training, evaluation benchmarking, synthetic data generation, and agent-harness
experimentation" — Prime Intellect, https://www.primeintellect.ai/blog/environments).
Run as an offline gate it is also the replay surface for
[`../simulate-before-launch/SKILL.md`](../simulate-before-launch/SKILL.md) —
judging a proposed model/prompt change before traffic moves. That's why building
it well — and validating it cheaply via eval *before* any GPU — pays off across
all of them.

**Four LEGO blocks (dataset · parser · rubric · rollout).** A `verifiers` env snaps
together from four independently-swappable pieces (Will Brown / Prime Intellect):

- **Dataset** — the tasks: `prompt` + gold `answer` + per-example `info`.
- **Rollout** — the harness / the "world": tools, turn budget, how state flows.
- **Parser** — turns raw model output into actions/answer (tool-call extraction,
  final-answer pull).
- **Rubric** — the reward: scoring function(s) + weights. The metric, not the trajectory.

The payoff is the seams — swap one brick, keep the rest: swap the **dataset** → new
task; swap the model in the **rollout** → model comparison on the *same* harness;
add a **rubric** function → reward something new; change the **consumer** → the same
env runs as eval, RL training, or synthetic-data gen (one env, many uses). This is
why the env is the durable asset and the trainer/model are swap-in bricks — how a
run can change model (e.g. Gemma-4 → Nemotron-3) or trainer (eval → prime-rl)
*without rebuilding the env*.

Caveat: the bricks look independent, but the **parser must match the model** (and
the trainer's renderer must too) — that's the seam that breaks on a new model arch.
When you swap the model brick, re-check the parser/renderer.

When the env is built as an actual `verifiers` Environment (the form
[`prepare-verifier-handoff`'s authoring and packaging stages](../prepare-verifier-handoff/references/stage-1-author-env.md) consume),
these API facts save real trial — re-verified against the `verifiers` `0.2.0`
source, 2026-07-14 (https://github.com/PrimeIntellect-ai/verifiers ; APIs move,
re-check the pin). Pin exactly `verifiers==0.2.0`: the tag and `main` diverged
within days of release. Note `0.2.0` ships **two API generations** — everything
below is the **v0 API**, still exported and working but frozen upstream
(deprecated, no new features); new upstream work lands in the `verifiers.v1`
Taskset/Harness/Runtime namespace (landscape notes in
[`reference.md`](reference.md)). Never mix v0 and v1 in one environment.
Don't start from a blank file: the traces→env recipe is
[`references/cookbook-traces-to-env.md`](references/cookbook-traces-to-env.md)
and the copyable, smoke-tested scaffold is
[`examples/event-categorizer/`](examples/event-categorizer/README.md):

- `vf.ToolEnv(tools=[fns], max_turns=, **kwargs)` — `dataset`, `rubric`,
  `system_prompt` pass through `**kwargs` to `MultiTurnEnv`; tools are plain
  functions (type hints + docstring → auto tool schema).
- **Tools are stateless** — a tool gets only its JSON args, not the dataset row.
  For per-example scoping (each task targets a different account/inbox), subclass
  ToolEnv and override `env_response(messages, state)` to set a **contextvar** from
  `state["info"]` before `super().env_response(...)`; tools read the contextvar
  (concurrency-safe across parallel rollouts).
- Dataset rows: `question` + `answer` + `info` (dict); verifiers derives `prompt`
  and `example_id`. Final answer = last assistant message with text (no submit
  tool; the episode ends when the model stops calling tools).
- Rubric: `vf.Rubric(funcs=[...], weights=[...])`; reward funcs take kwargs
  `(prompt, completion, answer, state, ...)` — pull what you need by name.
- Eval: `env.evaluate` is a **coroutine** — use `evaluate_sync` for blocking calls,
  and pass a verifiers **`ClientConfig`** (a raw `openai.OpenAI` raises
  "Unsupported client type"): `ClientConfig(client_type="openai_chat_completions",
  api_key_var="<ENV_VAR_NAME>", api_base_url="<…/v1>")` — `api_key_var` is the
  env-var *name* (default `PRIME_API_KEY`); `extra_headers` carries per-route
  headers. Pointed at the Understudy gateway this runs a full rollout+reward
  eval on CPU for pennies — strong pre-GPU validation.

## Output Standard

End with: the seeded fixtures and gold set; the tool classes simulated; the
validator's axes; the oracle's perfect score; and each candidate model's
recall/precision/policy + cost/latency — with the local-model gap to close.

When starting from a portable JSONL training plan, first render
`understudy training goal-card --plan <plan.json> --preview 0` and validate the
resulting `understudy.environment_proposal.v1` artifact. Increase the preview
only when useful; it is bounded to three TRAIN rows and never exposes held-out
targets. Model-authored environment proposals are design input only and remain
`needs_verifier` until the deterministic oracle, sentinels, reset, leakage,
live-effect, reward, hash, and parser gates pass.

## References

- [`references/trace-to-benchmark-foundry.md`](references/trace-to-benchmark-foundry.md) — machine-first trace compilation, review, promotion, and diminishing returns.
- [`references/automationbench-adaptation.md`](references/automationbench-adaptation.md) — reuse canonical stateful-benchmark patterns without losing trace provenance.
- [`references/resumable-environment-goal.md`](references/resumable-environment-goal.md) — automate trace batches with deterministic resumption and approval gates.
- [`references/cookbook-traces-to-env.md`](references/cookbook-traces-to-env.md) — the stage-by-stage recipe from captured traces/tests to a runnable verifiers env (gold policies, tool-stub strategies, contract rubric, playbook-as-argument, validator gates).
- [`examples/event-categorizer/`](examples/event-categorizer/README.md) — complete synthetic scaffold: env module, tasks, swappable playbooks, capture converter, and an offline `smoke.py` verified against `verifiers==0.2.0`.
- [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) — produces the shape this simulates.
- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md) — the harness that lifts a small model's score in this env.
- [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md) — the agentic-workload metric axes and final-state validation.
- [`../prepare-verifier-handoff/references/stage-1-author-env.md`](../prepare-verifier-handoff/references/stage-1-author-env.md) — inverts this batch-scored env into a `reset`/`step` MDP when the workload needs RL (the direct next rung before a hosted handoff).
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md) — when the env should graduate to a hosted RL/verifiers partner.
- [`../simulate-before-launch/SKILL.md`](../simulate-before-launch/SKILL.md) — runs this env as the offline ship/no-ship gate for a proposed model or prompt change.
