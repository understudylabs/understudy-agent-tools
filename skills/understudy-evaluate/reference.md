# Evaluate — Command Reference

Detailed command matrix, artifact contract, and interpretation rules for the
`understudy-evaluate` skill.

## Intake Checklist

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

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- metric definitions, sample size, split boundary, and caveats;
- approval-gated next step, if any;
- one recommended command.
