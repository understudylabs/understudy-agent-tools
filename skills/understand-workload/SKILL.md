---
name: understand-workload
description: Use when an AI workload needs local harness capture, environment attachment, metric and validator confirmation, frozen splits, and an incumbent baseline before optimization.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Understand Workload

Use this worker when the developer has not yet produced current local evidence
for the workload, or when any core artifact is missing, stale, ambiguous, or
untrusted.

The OSS loop does not require registration, auth, provider keys, an Understudy
account, or hosted gateway access. Do the smallest local pass that turns the
workload into auditable artifacts.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not read, print, commit, or transmit raw prompts, completions, traces, labels,
or datasets unless the developer explicitly approves the exact data class and
scope. Prefer metadata, paths, hashes, counts, schemas, and redacted examples.

## Goal

Create or refresh these artifacts under `.understudy/understand-workload/`:

```text
harness.json
environment.json
metric.json
splits.json
baseline.json
```

Each artifact must include a creation timestamp, source refs or path refs, and
enough provenance for another agent to repeat the step without guessing.

## Required Checks

1. Attach the harness.
   Capture the local runner, command, fixture path, entrypoint, timeout,
   dependency notes, input schema, output schema, and validator invocation in
   `harness.json`.
2. Attach the environment.
   Record language/runtime versions, package manager, relevant lockfile status,
   model/provider route used by the incumbent, local hardware notes when
   relevant, and required env var names without values in `environment.json`.
   If the harness needs a local proxy, bootstrap repair, or provider-key
   presence check, route to the existing public setup skill for that recovery
   path before claiming the baseline is runnable.
3. Confirm the scoring metric and validator.
   Write `metric.json` with the primary metric, pass/fail threshold,
   tie-breakers, validator command or callable, and failure taxonomy. If the
   metric or validator is unclear, stop and ask one concrete question.
4. Freeze splits.
   Write `splits.json` with train/dev/holdout names, sizes, source refs,
   deterministic split seed or frozen row ids, and an explicit "no holdout
   mutation" note.
5. Rerun the incumbent baseline.
   Use the frozen harness, metric, validator, and splits to rerun the current
   incumbent route. Write `baseline.json` with command, timestamp, split used,
   sample size, score, latency basis, cost basis if available, failures, and
   caveats. It must also include `harness_sha256`, `metric_sha256`, and
   `splits_sha256` for the exact artifacts used by the rerun.

## Flow

Start from the real local workload:

- app route, eval suite, trace export, benchmark fixture, prompt set, dataset,
  report, or existing runner;
- otherwise, create only a synthetic fixture and label it clearly as synthetic.

Do not optimize, tune prompts, choose replacement models, mutate splits, or
claim savings in this worker. Its job is to make the next validation step
possible.

If any artifact cannot be created, write down the missing input, the attempted
local command or inspection, and the next smallest action.

## Output Standard

End with:

- workload source inspected;
- artifact paths created or refreshed;
- metric, validator, split boundary, and incumbent baseline status;
- result type: workload-understanding or blocked;
- one recommended next local command or action.
