---
name: understudy-value-reporting
description: Turn local evaluation evidence into conservative value reports with measured quality, cost, latency, reliability, and caveats.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: true
---

# Understudy Value Reporting

Use this skill when the developer asks for ROI, savings, value, business
impact, replacement readiness, or decision reporting from Understudy evidence.

Do not use this skill to invent benefits or extrapolate beyond the measured
sample. Route missing measurement work to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function before running CLI
commands.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

Value reports must distinguish measured savings from scenario analysis. Do not
claim production savings, user impact, SLA improvement, or replacement
readiness without the artifact path and split boundary that support it.

## Evidence Ladder

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
as the public evidence ladder.

Every value report must include result type, sample size, split boundary,
baseline route, candidate route, cost basis, latency basis, and caveats. If the
evidence is below heldout validation, label replacement readiness as a
hypothesis or next-step recommendation, not a fact.

## Intake

1. Inspect the measured result packet, comparison report, eval summary, or
   local lab note.
2. Capture baseline route, candidate route, sample size, date, split, metric
   definitions, cost basis, latency basis, and failure exclusions.
3. Ask for the decision audience only if the report shape depends on it.
4. Run a local skill inventory check before assuming commands exist:

```sh
run_understudy skills
```

## Flow

1. Build the report around four columns: quality, cost, latency, and risk.
2. Use absolute values and deltas. If volume is unknown, provide per-unit
   economics and mark scaled savings as a scenario.
3. Include denominator and unit for every metric.
4. Keep recommendations tied to gates: keep baseline, promote candidate,
   expand eval, collect more traces, or run a live approval-gated test.
5. Put caveats near the claim they qualify.
6. If evidence is insufficient, say what artifact is missing and recommend the
   next local command.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
