---
name: optimize-api-workflow
description: Use to evaluate and optimize cross-application API workflow agents, including AutomationBench-like REST orchestration tasks where an agent discovers endpoints, follows policy docs, mutates state, and must pass final-state validators before any RL handoff.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Optimize API Workflow

Use this worker when the workload is an **API workflow agent**: a multi-step LLM
or agent loop that reads task instructions and policy docs, discovers or selects
REST endpoints, performs writes across one or more business systems, and is
judged by final state plus policy compliance. AutomationBench-style workflows
fit here better than generic search because correctness depends on stateful API
effects, not only the final answer.

This is still an evaluation, A/B, prompt, route, parser, and harness skill. It
is not RL training. Route to
[`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md)
only after local evidence shows that model choice and prompt/route optimization
cannot satisfy a stateful policy-learning requirement.

## Safety Gates

Default to the cheapest path that still reaches a decision. Get explicit
approval before any upload, hosted run, provider spend, live SaaS API call,
credential change, production write, model download, or benchmark submission.

Prefer local mocks, seeded fixtures, recorded schemas, and synthetic business
data. Do not print, commit, upload, or transmit raw prompts, completions, traces,
policy docs, customer data, request payloads, private repo paths, credentials, or
secrets without explicit approval for that exact data class and action. Treat
write-capable API tokens as production-impacting even when the task looks like an
eval.

## When To Use

Use this skill when all of these hold:

- the agent performs a multi-step API workflow, not a single prompt response;
- tools are REST, OpenAPI, RPC, or SDK calls with observable state changes;
- success requires final-state correctness and policy adherence;
- the harness can reset or seed state before each task;
- candidates should be compared on quality, latency, cost, and side-effect
  safety.

If the workload is live web search or browser/retrieval over read-only tools,
use [`../optimize-agentic-search/SKILL.md`](../optimize-agentic-search/SKILL.md).
If it is single-output, use
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) then
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).

## Artifact Pattern

Capture the API workflow into the standard evidence contract:

```text
.understudy/capture-evidence/harness.json
.understudy/capture-evidence/environment.json
.understudy/capture-evidence/metric.json
.understudy/capture-evidence/splits.json
.understudy/capture-evidence/baseline.json
```

For API workflows, `harness.json` must include the reset command, seed fixture,
task source, API schema or service map, allowed endpoint set, policy-doc refs,
agent entrypoint, request-log path, final-state validator, timeout, and network
boundary. `environment.json` must record the local service versions, mock server
or sandbox setup, required env var names without values, and whether any route
can write to live systems.

## Flow

1. **Confirm the workflow shape.** Name the apps/services, fixed API tools,
   policy docs, mutable state, incumbent model, and agent entrypoint. If there is
   no resettable state or validator, route back to `capture-evidence`.

2. **Freeze determinism.** Prefer local mock services or benchmark sandboxes.
   Record a deterministic reset: seeded state, API schemas, policy docs, task
   rows, allowed endpoints, clock/timezone, random seed, and network boundary.
   Each task run should start from a known state and emit a request log.

3. **Define the metric.** Quality is a weighted API-workflow rubric, not a
   generic answer score. Include final-state correctness, policy compliance,
   data accuracy, endpoint discovery, required-write completion, forbidden-write
   avoidance, unnecessary calls/retries, schema validity, and recoverable errors.
   Latency and cost are per workflow rollout. The metric must emit
   natural-language feedback tied to the failing step or invariant.

4. **Run the incumbent baseline.** Execute the frozen harness on train/dev or a
   small sanctioned sample, write per-task pass/fail and request-log summaries,
   and include `harness_sha256`, `metric_sha256`, and `splits_sha256` in
   `baseline.json`. Do not optimize until the baseline is measured.

5. **Pick the cheapest intervention.** Try parser/schema repair, prompt or
   policy-instruction repair, context trimming, endpoint-catalog compression,
   model A/B, or route changes before any training. Treat fewer unsafe writes,
   fewer redundant calls, and cleaner recovery behavior as first-class wins.

6. **Optimize only with fresh artifacts.** For prompt or route optimization, hand
   to [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) after the
   evidence artifacts are fresh and hash-bound. GEPA may use train/dev feedback
   only; never tune on holdout.

7. **Validate holdout last.** Freeze the candidate, then run holdout once.
   Claims require `claim.json` with sample size, split, quality delta, latency
   basis, cost basis, request-volume assumption, fallback route, demotion
   trigger, and caveats.

## Output Standard

End with:

- whether the workload was confirmed as an API workflow and the services named;
- reset/seed/state determinism status;
- metric axes and incumbent baseline status;
- request-log and final-state validator paths;
- candidate intervention or next worker skill;
- result type: evidence-capture, evaluation, optimization-lead, heldout, or
  verifier-handoff;
- one recommended next command or local action.
