---
name: capture-evidence
description: Use when an AI workload needs local harness capture, environment attachment, metric and validator confirmation, frozen splits, and an incumbent baseline before optimization.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Capture Evidence

Use this worker when the developer has not yet produced current local evidence
for the workload, or when any core artifact is missing, stale, ambiguous, or
untrusted.

The OSS loop does not require registration, auth, provider keys, an Understudy
account, or hosted gateway access. Do the smallest local pass that turns the
workload into auditable artifacts.

## Safety Gates

Default to the cheapest path that still reaches an optimization outcome — not to
zero spend (a skipped improvement has real opportunity cost). Get the
developer's explicit approval before any upload, hosted run, or provider spend.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not read, print, commit, or transmit raw prompts, completions, traces, labels,
or datasets unless the developer explicitly approves the exact data class and
scope. Prefer metadata, paths, hashes, counts, schemas, and redacted examples.

## Goal

Create or refresh these artifacts under `.understudy/capture-evidence/`:

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
   Model preflight: record whether the intended candidate/student model
   supports the workload's required capabilities (tool-calling,
   structured-output, vision, reasoning toggle) and whether its context window
   fits the workload's longest input. A context-window mismatch is a silent
   failure mode that later surfaces as confusing zero scores.
3. Confirm the scoring metric and validator (the load-bearing step).
   Write `metric.json` with the primary metric, pass/fail threshold,
   tie-breakers, validator, failure taxonomy, and `approved: true` only after a
   human confirms it. The metric is the real game: optimizing a *proxy* metric
   instead of the real validator is how prior runs scored 0/12. Record the
   validator `kind` and follow its rule:
   - `unit-test` / `golden` / `custom-command` — runs a deterministic check; the
     feedback is the assertion or diff that failed.
   - `schema` (e.g. Zod/JSON-schema `safeParse`) — keep `schema_pass` separate
     from `quality_pass`; a valid-shape, valid-enum output must not be failed
     merely for not matching a teacher trace verbatim.
   - `rubric` — a confirmed criteria list (each criterion: id, description,
     review type); auto-generated rubrics need human approval.
   - `llm-judge` — must debias position with a swapped two-pass score
     (`(r_ab − r_ba + 2) / 4`); never single-pass.
   - `human-review` — a blind, order-randomized packet; report judge-vs-human
     agreement separately from candidate preference.
   Whatever the kind, the metric must emit **natural-language feedback that
   diagnoses why** an output failed and what to change — not just a scalar.
   If the metric or validator is unclear, stop and ask one concrete question.
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
   Record the per-row (or per-cluster) pass/fail set, not just an aggregate
   score, so the next step can see whether optimization **headroom** exists —
   i.e. rows the incumbent fails that a stronger model could fix.

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
- result type: evidence-capture or blocked;
- one recommended next local command or action.
