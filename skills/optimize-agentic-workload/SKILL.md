---
name: optimize-agentic-workload
description: Use when a developer's agent — a multi-turn tool-calling loop — should get cheaper, faster, or better without retraining. "My agent is too slow", "this workflow costs too much", "test a cheaper model in my tool-calling loop", "A/B the policy model". Covers read-only search loops and state-mutating API workflows alike.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: true
---

# Optimize Agentic Workload

Use this worker when the workload is an **agentic loop**: an LLM that plans over
multiple turns and calls tools (web search, retrieval, REST/SDK calls, code
execution) before finishing. The model's policy is the variable; the tools are
held fixed. The goal is to pick the policy model you would ship on a
**multi-objective** basis — quality and latency and cost (and, for workflows
that write, side-effect safety) — using only skills and the public CLI, with no
new product code.

**The one discriminator that changes the playbook** is whether the loop
*mutates state*:

- **Read-only search loops** — web/agentic search, retrieval, lookup tools.
  Success depends on how the agent searches and the final answer; determinism
  comes from snapshotting live tool outputs. Harness specifics:
  [`references/read-only-search.md`](references/read-only-search.md).
- **State-mutating API workflows** — the agent discovers or selects endpoints,
  follows policy docs, performs writes across business systems, and is judged
  by final state plus policy compliance. Determinism comes from seeded,
  resettable state; safety (no forbidden writes) is a first-class objective.
  Harness specifics:
  [`references/state-mutating-workflows.md`](references/state-mutating-workflows.md).

Everything else — the artifact contract, the baseline gate, model A/B as the
primary lever, prompt optimization as the secondary one, and the three-gate RL
escalation — is shared.

This is not the handoff skill. Reach for
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
only after model A/B and prompt optimization are exhausted and the evidence
shows the agent must *learn stateful behavior*.

## Safety Gates

Default to the path with the highest expected progress toward the multi-objective
decision under hard constraints, not the cheapest rung. State the expected
quality, latency, safety, time, and spend tradeoffs; follow
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture. Launching a named bounded run plan authorizes its declared provider
calls, uploads, hosted jobs, tool calls, evaluation, receipts, and cleanup. Do
not pause for phase-by-phase confirmation. Ask again only before expanding its
displayed data, destination, spend, retention, credentials, or production-write
scope.

Use seeded fixtures and resettable sandboxes when the decision requires
repeatability. Treat production writes as a separate envelope from model and
training writes. Follow the repo public boundary in
[`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md)
for prompts, completions, tool outputs, traces, datasets, repo paths, and
secrets. Do not print or commit `sk_*` values; let
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
inject them into the child process only.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a
checkout:

```sh
npm run build
node dist/bin.js status --json
```

## When To Use

Use this skill when **all** of these hold:

- the workload runs a tool-calling loop, not a single prompt-in/answer-out call;
- success depends on *how the agent acts* (turn count, which tools, in what
  order, what it writes), not just the final string;
- the tools are fixed and available to every candidate model;
- the developer wants to compare candidate policy models, or shrink a frontier
  model down to a cheaper one without losing quality.

If the workload emits one output with no tool loop, route to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) then
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) instead —
single-output optimization does not need a tool environment.

## Flow

1. **Confirm it is agentic and pick the lens.** Inspect the workload for a
   multi-turn loop and tool calls. State the fixed tool set and the policy
   model that varies. Then classify: do any tools **mutate state**? Read-only →
   [`references/read-only-search.md`](references/read-only-search.md);
   state-mutating →
   [`references/state-mutating-workflows.md`](references/state-mutating-workflows.md).
   If it is single-output, hand back to `capture-evidence`.

2. **Adopt a runnable harness.** Read-only loops use a verifiers environment
   (`vf.Environment` + `Rubric`; the `vf-eval` command is the harness).
   State-mutating workflows use the existing benchmark/sandbox runner with a
   deterministic reset (seeded state, fixed API schemas, fixed policy docs,
   final-state validator). Either way, capture it into the
   `.understudy/capture-evidence/` artifact contract — each reference documents
   the env → artifact bridge for its shape.

   Before using model scores, pass the shared evaluation evidence gates in
   [`../capture-evidence/references/evaluation-evidence-gates.md`](../capture-evidence/references/evaluation-evidence-gates.md).
   In particular, run a synthetic read-then-write trajectory through the exact
   driver for every model family. The driver must append the read result,
   continue the loop, execute the terminal write, and score final state; an
   intermediate tool call is never a no-op verdict.

   If Desktop produced `understudy.environment_proposal.v1` from a JSONL drop,
   treat `status: executable` as meaningful only after
   `understudy training validate-environment-proposal --proposal <path>` passes.
   An Understudy draft with `status: needs_verifier` is a proposal, not a
   harness or score; author the missing parser/environment/oracle/sentinels and
   rerun deterministic validation before any model comparison.

3. **Define multi-objective success.** Quality is a per-criterion LLM-judge or
   final-state rubric that returns natural-language *why/what-to-change*
   feedback, not a bare score. Latency and cost come from the rollout records
   (turn counts, tool/API call counts, timing, token usage) — read those
   instead of inventing a meter. State-mutating workflows add a
   **side-effect-safety** axis (forbidden writes, invalid requests, retries).
   Record the axes and an acceptable-regression band in `metric.json`.

4. **Freeze determinism.** Read-only: live tool calls are non-deterministic, so
   freeze the query set and **snapshot/cache the tool outputs** so the harness
   replays reproducibly and the holdout stays clean. State-mutating: record a
   deterministic reset — seeded state, schemas, policy docs, task rows, allowed
   endpoints, clock, seed, network boundary — so each run starts from a known
   state and emits a request log.

5. **Run the incumbent baseline before optimizing.** Execute the frozen harness
   on the sanctioned train/dev set, write per-task results, and bind
   `harness_sha256`, `metric_sha256`, and `splits_sha256` into `baseline.json`.
   Confirm coverage across completed-execution strata, including rare or
   high-consequence tool paths, and inspect the actual trajectories behind at
   least one pass, each reported failure class, each surprising delta, and a
   counterexample to the proposed headline. Do not optimize until the baseline
   is measured and those checks pass. A smaller pilot may validate plumbing, but
   it is not the baseline evidence. Expand the cohort whenever estimates remain
   unstable, important strata are underfilled, or review discovers new failure
   classes.

6. **Attribute the multi-turn gap before intervening.** Read the rollouts, not
   just the final score, and tag where reward is lost: wrong tool/endpoint,
   wrong argument value, **result-propagation** (mis-copying a value a prior
   tool returned into a later call), failure to recover from a tool error,
   forbidden or missing writes, or non-termination. Single-turn /
   next-tool-call imitation scores are a *leading indicator only* — they cannot
   see result-propagation, recovery, or termination, which exist only inside
   the running environment. Let the attribution pick the **highest-leverage rung
   likely to close the gap**: output-contract repair (prefill / format / parser /
   schema), tool-access or endpoint-catalog repair, model A/B, prompt / GEPA
   (automatic prompt evolution), distillation, or RL. Use the cheaper rung first
   only when evidence says it can solve the attributed failure; skip directly to
   a stronger model or broader intervention when weak iterations would only
   delay the answer.

7. **PRIMARY intervention — model A/B via the CLI.** This is the main move:

   ```sh
   understudy models list --json
   understudy workloads route <workload-id> --project-id <project-id> \
     --model-id glm-5.1 --traffic-pct 100
   understudy run -- <harness command>
   ```

   List public model options, route the project workload to a chosen model,
   then run the frozen harness through the gateway with `understudy run`.
   Compare quality vs latency vs cost (vs side-effect safety) across candidates
   and pick the model you would ship. For keyless accounts, prefer a
   managed-catalog sweep on a cleared/no-route workload before traffic-split
   A/B. Prerequisite for a traffic split: the non-routed passthrough share
   needs a configured managed provider credential or BYO key so untouched
   traffic still completes. Clear a route with `--clear`. Routing detail lives in
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).
   For state-mutating workflows, A/B is often simpler: run the same harness
   rows twice with only the model changed (see the reference).

8. **SECONDARY intervention — optimize the cheap model's prompt.** If a cheaper
   model wins on latency and cost but trails on quality, close the gap with a
   train/dev-only GEPA pass against the feedback-rich rubric, keeping the
   latency/cost win. Hand this off to
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md); never tune
   on holdout.

9. **Escalate to RL only as a true handoff, behind three gates.** If model swap
   and prompt/distillation stall while real headroom remains and the residual
   is genuinely *stateful* multi-step behavior, route to
   [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
   First confirm: (a) the attribution in step 6 shows **cross-turn reasoning**
   is the residual, not format/argument-value (which are cheaper to fix); (b)
   the reward is **dense, not strict** — a binary/strict reward can be constant
   within a group, giving zero advantage and no gradient (paid-for, wasted
   steps); and (c) the model has a first-class multi-turn GRPO **trainer and
   renderer** (e.g. NVIDIA Nemotron-3 does; Google Gemma-4 does not yet), or
   the RL run is wasted before it starts. This repo never runs that training.

Capture evidence before you optimize, exactly as the rest of the MVP loop
requires (see [`../understudy/SKILL.md`](../understudy/SKILL.md)). The decision
must rest on a measured baseline, and any savings statement needs the
`claim.json` packet that `optimize-workload` enforces.

## Output Standard

End with:

- whether the workload was confirmed agentic, which lens applied (read-only vs
  state-mutating), and the fixed tool set named;
- the harness id/command used (verifiers env or workflow runner);
- the objective axes (quality / latency / cost / side-effect safety where
  applicable) and the baseline numbers;
- whether determinism was frozen (tool snapshot or seeded reset) and the
  holdout stayed clean;
- the model A/B result and the model you would ship;
- result type: evidence-capture, evaluation, optimization-lead, heldout, or
  handoff;
- one recommended next command or local action.

## References

- [`references/read-only-search.md`](references/read-only-search.md) — verifiers
  ToolEnv harness, tool-output snapshotting, the env → artifact bridge, and the
  CLI A/B procedure for read-only loops.
- [`references/state-mutating-workflows.md`](references/state-mutating-workflows.md)
  — resettable sandbox harness, final-state/policy rubric, tool-access
  reporting, failure-mode table, and the GEPA bridge for multi-step rollouts.
