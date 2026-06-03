---
name: understudy-evaluate
description: Use when comparing prompts, traces, datasets, scorers, routes, local models, provider models, or candidate outputs to find measurable cost, latency, quality, reliability, or portability value.
metadata:
  understudy:
    mode: interactive
    safety: value-first
    cli_required: true
---

# Understudy Evaluate

Use this skill when the developer needs a credible answer to: "Can this workload
run cheaper, faster, more reliably, or more portably without unacceptable quality
loss?"

Evaluation is the first value moment. Do not turn it into a checklist of
cost-free probes. Start from the user's real workload when available, establish
baseline economics, choose the fastest useful candidate path, and run the
smallest comparison that can change a decision.

Do not use this skill for optimization after a measured baseline exists. Route
those requests to [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
For SFT, adapters, preference data, or training handoff, route to
[`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Value Posture

Prefer the path that produces decision-grade evidence soonest:

- existing eval suite, traces, logs, prompt set, or app route over a toy fixture;
- local replay when it can estimate quality or regression risk;
- public local/open models when they can expose cost or latency upside;
- existing provider keys when the developer has them and approves a capped run;
- Understudy inference when it reduces setup time or avoids per-provider glue;
- a small live comparison when replay cannot answer the economic question.

Be explicit about economics:

- current model or route;
- input/output token shape or request volume;
- latency target and observed latency;
- cost/request or cost/month estimate;
- quality gate and acceptable regression band;
- candidate route, model, or runner;
- decision the eval will unlock.

## Safety Gates

Default storage is local. Do not upload source files, prompts, traces, outputs,
datasets, repo paths, private notes, provider keys, or secrets unless the
developer explicitly approves that exact action in the current thread.

Configured provider keys and Understudy API keys are usable only after approval
for a named, capped action. Before live calls, hosted runs, uploads, benchmark
submission, model downloads, or training, require:

- named provider, model, registry, or hosted surface;
- estimated or capped spend, or estimated download size;
- exact artifact or data class being sent or downloaded;
- visible output path under `.understudy/`;
- dry-run, preview, or local plan when available.

Keep split boundaries explicit. Do not tune prompts, scorers, renderers, or
routes on heldout rows.

## Evidence Ladder

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
as the public evidence ladder.

Do not claim replacement readiness from static scans, fixture smokes, or
dry-runs. Evaluation reports must label the result type, sample size, split
boundary, baseline route, candidate route, cost basis, latency basis, and
caveats.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - intake checklist, command flow, failure
  triage, artifact contract, and output standard.
- [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md)
  - model capability and route compatibility checks before benchmarking.
- [`../understudy-local-models/SKILL.md`](../understudy-local-models/SKILL.md)
  - local runner questions.
- [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md)
  - post-baseline improvement loop.
- [`../understudy-value-reporting/SKILL.md`](../understudy-value-reporting/SKILL.md)
  - decision and value reporting.
