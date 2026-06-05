# Evaluate — Command Reference

Detailed command matrix, artifact contract, and interpretation rules for the
`understudy-evaluate` skill.

Future commands should preserve the value-first contract:

- start from the user's real workload when available;
- establish baseline cost, latency, quality, reliability, and sample size;
- compare against the fastest plausible candidate path: local model, public
  model download, existing provider key, Understudy inference, replay, or
  managed route;
- preserve split boundaries and heldout integrity;
- run dry-run or replay paths when they can answer the economic question;
- allow capped live runs when replay cannot answer the value question and the
  developer approves spend/upload;
- require explicit approval for upload, spend, hosted jobs, or benchmark
  submission.

## Intake Checklist

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
