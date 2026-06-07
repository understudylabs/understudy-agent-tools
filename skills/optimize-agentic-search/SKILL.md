---
name: optimize-agentic-search
description: Use to evaluate and optimize an agentic / tool-use workload (a multi-turn LLM tool-calling loop such as agentic web or hotel search) by holding tools fixed and A/B-testing the policy model on quality, latency, and cost — before any RL handoff.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Optimize Agentic Search

Use this worker when the workload is an **agentic / tool-use loop**: an LLM that
plans over multiple turns and calls live tools (web search, retrieval, hotel or
flight lookup, code execution) before producing an answer. The model's policy is
the variable; the tools are held fixed. The goal is to pick the policy model you
would ship on a **multi-objective** basis — quality and latency and cost — using
only skills and the public CLI, with no new product code.

This is not the handoff skill. Reach for
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
only after model A/B and prompt optimization are exhausted and the evidence
shows the agent must *learn stateful behavior*.

## Safety Gates

Default to the cheapest path that still reaches a decision — not to zero spend (a
skipped improvement has real opportunity cost). Get the developer's explicit
approval before any upload, hosted run, or provider spend, including every live
tool call and every gateway eval run.

Do not run live provider calls, tool calls, hosted jobs, model downloads, or
uploads without a named surface, capped spend, exact data class, a reviewed
dry-run or local plan, and a visible output path under `.understudy/`. Follow the
repo public boundary in
[`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md)
for prompts, completions, tool outputs, traces, datasets, repo paths, and
secrets. Do not print or commit `sk_*` values; let
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) inject
them into the child process only.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a checkout:

```sh
npm run build
node dist/bin.js status --json
```

## When To Use

Use this skill when **all** of these hold:

- the workload runs a tool-calling loop, not a single prompt-in/answer-out call;
- success depends on *how the agent searches* (turn count, which tools, in what
  order), not just the final string;
- the tools are fixed and available to every candidate model;
- the developer wants to compare candidate policy models, or shrink a frontier
  model down to a cheaper one without losing quality.

If the workload emits one output with no tool loop, route to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) then
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) instead — single
-output optimization does not need a tool environment.

## Flow

1. **Confirm it is agentic.** Inspect the workload for a multi-turn loop and live
   tool calls. State the fixed tool set and the policy model that varies. If it
   is single-output, hand back to `capture-evidence`.

2. **Adopt a verifiers environment as the harness.** Use a Prime Intellect
   `verifiers` environment (a `vf.Environment` + `Rubric`) as the eval. The
   `vf-eval` command is the runnable harness; the environment holds the tools
   fixed so only the policy model changes between runs. Capture this into the
   `.understudy/capture-evidence/` artifact contract — see
   [`reference.md`](reference.md) for the env → artifact bridge.

3. **Define multi-objective success.** Quality is a per-criterion LLM-judge
   rubric that returns natural-language *why/what-to-change* feedback, not a bare
   score. Latency and cost come for free: a verifiers `ToolEnv` emits
   `num_turns`, tool-call counts, timing, and token usage per rollout — read
   those for the latency and cost axes instead of inventing a meter. Record all
   three axes and an acceptable-regression band in `metric.json`.

4. **Snapshot the tools (determinism gate).** Live web/tool calls are
   non-deterministic and time-varying, which breaks hash-stable harness/splits
   and holdout integrity. Freeze the query set and **cache the tool outputs** for
   those queries so the harness replays reproducibly and the holdout stays clean.
   See [`reference.md`](reference.md) → Determinism.

5. **Attribute the multi-turn gap before intervening.** Read the environment's
   multi-turn rollouts, not just the final score, and tag where reward is lost:
   wrong tool, wrong argument value, **result-propagation** (mis-copying a value a
   prior tool returned into a later call), failure to recover from a tool error,
   or non-termination. Single-turn / next-tool-call imitation scores are a
   *leading indicator only* — they cannot see result-propagation, recovery, or
   termination, which exist only inside the running environment. Let the
   attribution pick the **cheapest rung that closes the gap**, in order:
   output-contract repair (prefill / format) → model A/B → prompt / GEPA →
   distillation → RL. Often the gap is format or argument-fidelity, not planning,
   and a cheap rung wins.

6. **PRIMARY intervention — model A/B via the CLI.** This is the main move:

   ```sh
   understudy models list --json
   understudy workloads route <workload-id> --project-id <project-id> \
     --model-id glm-5.1 --traffic-pct 100
   understudy run -- <vf-eval command>
   ```

   List public model options, route the project workload to a chosen model at a
   traffic percentage, then run the `vf-eval` harness through the gateway with
   `understudy run`. Compare quality vs latency vs cost across candidates and
   pick the model you would ship. Prerequisite: an A/B split sends only the
   routed share to the chosen model; the non-routed share needs a configured
   managed frontier fallback so untouched traffic still completes. Clear a route
   with `--clear`. Routing detail lives in
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

7. **SECONDARY intervention — optimize the cheap model's prompt.** If a cheaper
   model wins on latency and cost but trails on quality, close the gap with a
   train/dev-only GEPA pass against the feedback-rich rubric, keeping the
   latency/cost win. Hand this off to
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md); never tune
   on holdout.

8. **Escalate to RL only as a true handoff, behind three gates.** If model swap
   and prompt/distillation stall while real headroom remains and the residual is
   genuinely *stateful* multi-step behavior, route to
   [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
   First confirm: (a) the attribution in step 5 shows **cross-turn reasoning** is
   the residual, not format/argument-value (which are cheaper to fix); (b) the
   reward is **dense, not strict** — a binary/strict reward can be constant within
   a group, giving zero advantage and no gradient (paid-for, wasted steps); and
   (c) the model has a first-class multi-turn GRPO **trainer and renderer** (e.g.
   NVIDIA Nemotron-3 does; Google Gemma-4 does not yet), or the RL run is wasted
   before it starts. This repo never runs that training.

Capture evidence before you optimize, exactly as the rest of the MVP loop
requires (see [`../understudy/SKILL.md`](../understudy/SKILL.md)). The decision
must rest on a measured baseline, and any savings statement needs the
`claim.json` packet that `optimize-workload` enforces.

## Output Standard

End with:

- whether the workload was confirmed agentic and the fixed tool set named;
- the verifiers environment id and `vf-eval` command used as the harness;
- the three objective axes (quality / latency / cost) and the baseline numbers;
- whether tool outputs were snapshotted and the holdout stayed clean;
- the model A/B result and the model you would ship;
- result type: evidence-capture, evaluation, optimization-lead, heldout, or
  handoff;
- one recommended next command or local action.
