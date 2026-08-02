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

Checks beyond the scripted oracle, before any model score is trusted:

- **The verifier fixture-test rule.** Before trusting any verifier, it must
  pass a two-fixture test: one known-valid result must **pass** and one
  plausible-but-wrong result must **fail**. Both fixtures live next to the
  verifier and rerun on every verifier change. A verifier that has never
  rejected a wrong answer has not been tested — do not score, regrade, or
  calibrate against it.

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

## Environment rigor checklist (ABC)

Before any cross-model comparison, the environment must pass this checklist,
adapted from the Agentic Benchmark Checklist
([uiuc-kang-lab/agentic-benchmarks](https://github.com/uiuc-kang-lab/agentic-benchmarks)).
Canonical failures it prevents: a do-nothing agent scoring 38% on tau-bench,
SWE-Lancer agents reading protected answer files, WebArena string-match
exploits. Full mapping in
[`../../docs/benchmark-rigor.md`](../../docs/benchmark-rigor.md).

- **Oracle solver exists and scores 1.0.** Every task must be verified
  solvable by the scripted oracle (recipe step 5) — a task no oracle can
  complete measures nothing. Record the oracle run alongside the env.
- **Null-agent floor run.** Run a do-nothing agent (immediately calls
  `finish`, writes nothing) through the same driver and validator. If it
  scores above ~5%, the benchmark is miscalibrated: too many obligations are
  satisfied by default state, or the metric rewards absence. Fix the gold set
  or the validator before trusting any model score.
- **Gold-leakage audit.** Confirm the candidate cannot read the expected
  final state: gold answers must not appear in seeded fixtures, tool results,
  file listings, error messages, or record fields the read tools can reach.
  Grep the reachable synthetic state for gold keys/values; anything findable
  by a read call is a leak. For trace-compiled environments this is now
  partly automatic: `understudy traces build-benchmark` splits fixtures into
  candidate-readable pre-state (`fixtures.json`, task_id-scoped) and
  scorer-only post-state (`gold.json`, never served to a rollout), and runs a
  tiered leakage audit — tier 1 verbatim matches are `findings`, tier 2 fuzzy
  shingle/fingerprint matches are `advisory` — recorded report-only in
  `manifest.leakage_audit`. Read that record first; keep the manual grep for
  environments built any other way.
- **State isolation between rollouts.** Each rollout must start from a fresh
  deep copy of the seeded state — no residual writes from a previous run, no
  shared mutable module-level state, no order dependence. Prove it: run the
  same task twice back-to-back and once after an unrelated task; scores must
  match.
- **Contract complexity.** Single boolean obligations ("did it set the flag")
  are guessable — a coin-flip agent clears them half the time. Prefer gold
  states with multiple required keys/values plus forbidden writes, so recall,
  precision, and policy must all hold at once.
- **Attest it.** For a benchmark directory, `understudy benchmarks rigor
  <dir>` writes `rigor-report.md` — the ABC attestation over the artifacts on
  disk (oracle solvability, null/spam trivial-arm floors from
  `calibration.json`, incumbent calibration, per-task contract complexity,
  anomaly counts, contamination provenance) with honest UNKNOWN rows for
  items tooling cannot check yet. Queue the trivial floors themselves via the
  run executor (`trivial_arms: ["null_agent", "spam_agent"]`); see
  [`../operate-benchmark-lab/SKILL.md`](../operate-benchmark-lab/SKILL.md).

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

For trace-derived work, generate the environment through `understudy traces
build-benchmark`; do not begin from the legacy v0 example. The helper was
live-verified on 2026-07-29 against Prime Intellect Verifiers `0.2.1`
(release commit `ab65b6e8d34b03d162408d4bcb854430a86809e6`). It emits the current typed
`TasksetConfig`/`Taskset`, per-rollout `State`, `Toolset` methods, strict and
dense rewards, `HarnessConfig`/`Harness`, and `load_environment(EnvConfig)`
package shape, with the audited commit recorded in the canonical benchmark.

The checked-in event-categorizer remains a legacy v0 compatibility example;
never copy it into a new trace-derived environment. Use the helper lifecycle in
[`../ingest-traces/references/trace-foundry-cli.md`](../ingest-traces/references/trace-foundry-cli.md).
Re-audit upstream before changing the generator's commit pin, then smoke-install
and import the generated package against that exact commit.

## Export targets

A finished environment need not stay local-only. `benchmark.v1` already
records external lineage via `provenance.imported_from`
(`format: verifiers.v1 | verifiers.v0 | harbor | inspect_ai |
automationbench | hf-dataset | other`, plus `ref`/`version`/`license`), and
the same formats work in reverse as export targets:

- **Harbor** (github.com/harbor-framework/harbor) — a task directory per
  task: `task.toml` carrying the task's **semver version** (the same
  major/minor/patch contract as our task versioning) and `dataset.toml`
  pinning inputs by **sha256 digests**. Our per-task `version` +
  `content_hashes` map onto that shape directly.
- **verifiers / Prime Intellect Environments Hub** — package the env as a
  `verifiers` v1 environment (the shape `understudy traces build-benchmark`
  already generates) and publish to the Environments Hub; record the hub
  slug and pinned version so a re-import round-trips through
  `imported_from`.

Manifests carry references and digests, never inline gold, prompts, or
secrets — that rule holds for exports too.

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
- [`../audit-verifier-reliability/SKILL.md`](../audit-verifier-reliability/SKILL.md) — audit whether its reward is safe to optimize before claiming an RL lift.
- [`../simulate-before-launch/SKILL.md`](../simulate-before-launch/SKILL.md) — runs this env as the offline ship/no-ship gate for a proposed model or prompt change.
