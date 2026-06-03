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

## Intake

1. Identify the value target: cost, latency, quality, reliability, portability,
   local privacy, or model availability.
2. Inspect the real workload source: trace store, logs, eval report, dataset,
   prompt set, app route, scorer, or benchmark script.
3. Capture baseline facts: incumbent route, sample size, metric, latency,
   cost/request, error rate, and known failure modes.
4. Identify candidate paths: local model, public model download, existing
   provider key, Understudy inference, replay, or managed provider.
5. Choose the smallest comparison that can change the decision.

Ask at most one clarifying question if the workload source or approval boundary
is ambiguous.

## Flow

1. Check the CLI and evaluation surface:

```sh
run_understudy --help
run_understudy evaluate --help
```

2. Inspect existing artifacts before creating new work:

```sh
run_understudy evaluate status --local
run_understudy evaluate validate --dry-run
```

3. If there is a plausible local/open candidate, inspect model fit before
benchmarking:

```sh
run_understudy local-models doctor --local --dry-run
run_understudy model lookup --local --dry-run
```

4. If replay can answer the question, run a local comparison first:

```sh
run_understudy evaluate run --dry-run --local
```

5. If replay cannot answer the value question and the developer has approved a
capped live run, use the smallest live sample that can establish direction.
Record actual spend, latency, output validity, and quality deltas.

6. Read generated artifacts under:

```text
.understudy/evaluate/
.understudy/model-lookup/
.understudy/local-models/
```

7. Report the result as a decision, not just a score: promote candidate,
optimize next, download/run a local model, use Understudy inference, expand the
sample, or stop because the economics do not justify more work.

## Failure Triage

Before blaming model quality, classify failures:

- context-window or token-cap mismatch;
- parser or schema failure;
- route or provider error;
- scorer/rubric mismatch;
- missing labels or weak sample size;
- latency bottleneck outside inference;
- incompatible tool-call or structured-output format;
- true quality regression.

Route model fit questions to
[`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md).
Route local runner questions to
[`../understudy-local-models/SKILL.md`](../understudy-local-models/SKILL.md).
Route post-baseline improvement to
[`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
Route decision/value reporting to
[`../understudy-value-reporting/SKILL.md`](../understudy-value-reporting/SKILL.md).

## Output Standard

End with:

- baseline route, candidate route, and value target;
- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, local smoke, replay, validation, heldout, or live;
- sample size, metric definitions, latency, cost, and quality caveats;
- decision unlocked or still blocked;
- spend/upload/download approval boundary, if any;
- one recommended command.
