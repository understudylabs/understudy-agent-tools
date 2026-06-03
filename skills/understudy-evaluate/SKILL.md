---
name: understudy-evaluate
description: Use when comparing prompts, traces, datasets, scorers, routes, or model candidates with local-first evaluation evidence.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Evaluate

Use this skill when the developer asks to evaluate a workload or compare
quality, latency, reliability, cost, scorers, prompts, routes, or model
candidates.

Do not use this skill for optimization after a measured baseline exists. Route
those requests to [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
For fine-tuning, SFT, adapter, or training-data requests, route to
[`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work. Prefer local artifacts,
synthetic fixtures, replay data, and dry-run plans before live provider calls.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- reviewed dry-run or preview artifact;
- visible output path under `.understudy/`.

Keep split boundaries explicit. Do not inspect heldout labels or tune prompts,
scorers, renderers, or routes against heldout rows.

## Intake

1. Inspect the real local workload source: trace store, dataset, eval report,
   repo script, prompt set, scorer, or synthetic fixture.
2. Identify the decision: baseline measurement, route comparison, scorer
   validation, regression check, or readiness gate.
3. Record row count, split names, metric definitions, candidate routes, and
   known missing data before running comparisons.
4. Run the smallest no-spend status, validation, replay, or dry-run command.
5. Summarize current state before proposing paid, hosted, or upload steps.

## Flow

1. Check local CLI health and available evaluation surfaces:

```sh
run_understudy --help
run_understudy evaluate --help
```

2. If the workload already has local artifacts, inspect or validate them before
   creating new runs:

```sh
run_understudy evaluate status --local
run_understudy evaluate validate --dry-run
```

3. If local artifacts are missing, start with fixtures or a replay-only dry run:

```sh
run_understudy evaluate run --dry-run --local
```

4. Read generated artifacts under:

```text
.understudy/evaluate/
```

5. Separate catalog facts from measured results. A model card, route config, or
   provider listing is not evaluation evidence.

6. Report failures as actionable inputs: parser mismatch, missing labels,
   scorer drift, context-window mismatch, token-cap mismatch, route error,
   sample-size gap, or spend/upload gate.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - detailed command matrix, artifact contract,
  and interpretation rules.
- [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md)
  - model capability and route compatibility checks before benchmarking.
- [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md)
  - post-baseline improvement loop.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- metric definitions, sample size, split boundary, and caveats;
- approval-gated next step, if any;
- one recommended command.
