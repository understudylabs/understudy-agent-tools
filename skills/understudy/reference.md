# Understudy orchestrator — reference

Depth for [`SKILL.md`](SKILL.md). The orchestrator routes; the workers do the
work. This file holds the framing the orchestrator reuses across every job:
intake, objective menus, constraints, route selection, the fresh-pricing rule,
the report template, anti-patterns, examples, and a glossary.

## Intake (ask only what you can't infer)

Inspect the repo first (see `capture-evidence`), then ask at most these four:

1. **Objective** — cost, speed, quality, reliability, compliance, or a weighted
   mix.
2. **Target task** — e.g. support-ticket triage, coding-agent tool use, bug
   classification, retrieval QA, extraction, sales-email generation, internal
   workflow automation.
3. **Constraints** — SOC 2, ZDR, approved providers, no data leaves the machine,
   max cost/run, max latency, required model family, hosting region.
4. **Environment** — local-only, Understudy hosted, private gateway, or hybrid.

Do not ask anything the repo answers. Surface what you found instead.

## Objective menus

- **A. Quality** — task success rate, classification accuracy, tool-use
  correctness, extraction quality, reliability, fewer hallucinations, better
  instruction following.
- **B. Cost** — cheaper model for easy cases, premium model only for hard cases,
  cache/batch repeats, fewer tokens, prompts that avoid retries, swap a
  provider/model when equivalent quality is cheaper.
- **C. Speed** — lower latency, faster provider/model, fewer tool calls,
  parallelize safe steps, simpler prompts, small models for routing/triage.
- **D. Constraints** — see below; treat as hard limits, not objectives.
- **E. Route** — best harness / model / supplier; local vs hosted; when to use
  the Understudy inference layer, gateway-only, or local-only.

A single change often moves several at once (e.g. a prompt that stops retries
cuts both cost and latency) — measure all affected axes, not just the target.

## Constraints (detect, respect, gate)

Detect from the repo and the developer: SOC 2, ZDR, local-only, data-retention
limits, PII handling, credential boundaries, approved-provider lists, budget
ceilings, latency SLOs, security-review requirements, production change controls.
Look in compliance docs, READMEs, env var names, provider config, and CI.

Respect them as hard limits. Map each to allowed actions, e.g.:

- **ZDR / no hosted upload** → local-only traces; no hosted trace upload unless
  explicitly approved; local optimization only.
- **Approved providers only** → never propose or switch to an unlisted provider.
- **Region/residency** → only routes/suppliers in the allowed region.
- **Budget ceiling / latency SLO** → reject candidates that exceed it even if
  quality wins.

Any action that uploads data, spends money, changes credentials, deploys
behavior, or alters a production route requires explicit confirmation unless
unattended mode is configured. State the data class and the exact action.

## Route selection

Recommend the most efficient route across four axes:

- **Harness** — existing app harness, the Understudy trace/eval harness, a
  framework-specific harness, or a custom lightweight one.
- **Model** — current, smaller/cheaper, stronger-for-hard-cases, local, or
  fallback.
- **Supplier** — current provider, an alternative, the Understudy inference
  layer, a private deployment, or a local runtime.
- **Routing strategy** — single model, cascade, router model, confidence-based
  escalation, or cost-/latency-/compliance-aware routing.

Execute and measure routes through the gateway primitives (see
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)):
`understudy models` to see public options, `understudy workloads` to route a
workload to a model at a traffic percentage (A/B), `understudy run` to drive an
eval through the gateway, and the `route-decision` packet to record the choice.

### Fresh-pricing rule

Never make cost, availability, or capability claims from memory. Use fresh data:
the Understudy platform/model catalog where available, and official provider docs
or the web otherwise. Label every assumption and date it. A pricing claim without
a current source is not a claim — it's a guess.

## Deploy and compare

Keep the baseline reproducible. Apply the smallest viable change — prefer config
or a workload route over editing hardcoded call sites. Register/route the improved
behavior through the inference layer when appropriate (gateway route + traffic %),
or write a local deployment artifact / `understudy.yaml` in local-only mode.
Always include rollback steps, run comparison evals, show before/after metrics,
and list regressions — never bury them.

## Understudy Agent Improvement Report

Produce this for every completed improvement attempt:

```text
# Understudy Agent Improvement Report
1. Objective
2. Constraints
3. Current architecture
4. Trace source
5. Eval harness
6. Baseline results
7. Optimization method
8. Candidate changes
9. Route recommendation
10. Before/after comparison
11. Cost / latency / quality tradeoffs
12. Risks and regressions
13. Deployment steps
14. Rollback steps
15. Open questions
```

## Anti-patterns (do not let the agent do these)

- Rewrite large parts of the app before measuring a baseline.
- Optimize without an eval.
- Claim an improvement without a before/after comparison.
- Upload traces without confirmation, or expose secrets.
- Switch providers without checking constraints.
- Make pricing/availability claims without current data.
- Deploy production changes without approval.
- Bury or omit regressions.

## Examples

- **Cheaper support triage** — inspect repo → find provider/prompts → confirm the
  triage task → build/locate eval → capture traces → measure tokens+latency →
  split easy/hard → propose a cheaper route → optimize the prompt → compare cost
  and quality → recommend the route (`capture-evidence` → `optimize-workload` /
  `use-understudy-gateway`).
- **Tool-use reliability** — inspect tool defs + traces → build evals from failed
  tool calls → optimize tool descriptions/system prompt → compare success rate →
  report regressions (`optimize-agentic-search`).
- **SOC 2 + ZDR quality** — confirm the data boundary → local-only traces, no
  hosted upload → approved providers only → local optimization → report suitable
  for security review.
- **Fastest safe route** — baseline latency → check current model availability
  (fresh data) → latency-aware eval → test candidates → recommend by measured
  latency at a quality threshold (`use-understudy-gateway` route A/B).
- **Gemma-4 demo** — run a small task suite with Gemma-4 through the Understudy
  gateway (mock provider if unavailable) → capture → eval → optimize → compare →
  report the full loop.

## Glossary

- **Harness** — the runnable shape that executes the task and scores it
  (app-native, Understudy artifact contract, or a verifiers env).
- **Route** — the chosen harness + model + supplier + routing strategy +
  deployment path.
- **Trace** — a recorded LLM/tool call (prompt, response, tool calls, latency,
  tokens, errors, metadata) captured through the gateway.
- **Baseline / candidate** — the incumbent vs a proposed change, scored on the
  same frozen eval split.
- **Claim** — a hash-bound, evidence-backed statement of measured improvement
  (`optimize-workload` `claim.json`).
- **Local-only / hosted / gateway / hybrid** — where work runs and whether data
  leaves the machine.
