---
name: capture-evidence
description: Use when a developer wants to build an eval from their real LLM app before changing anything — "measure how my app is doing today", "build an eval from my workload", "we have no baseline", "is my current model actually good". Turns the workload into auditable local artifacts (harness, metric, frozen splits, baseline); has a public-benchmark on-ramp when no traces exist.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Capture Evidence

Use this worker when the developer has not yet produced current local evidence
for the workload, or when any core artifact is missing, stale, ambiguous, or
untrusted.

The OSS loop does not require registration, auth, provider keys, an Understudy
account, or hosted gateway access. Do a sufficient local pass that turns the
workload into auditable artifacts and can answer the named decision.

## Safety Gates

Default to the evidence plan most likely to resolve the decision under the
developer's constraints, not the cheapest or smallest pass. Make cost, time,
scope, and expected confidence visible; use
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture. A developer action that launches a named bounded evidence plan
authorizes its declared uploads, hosted calls, model evaluation, receipts, and
cleanup. Ask again only if the plan expands its displayed envelope.

Follow the repo public boundary in
[`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md).
Prefer metadata, paths, hashes, counts, schemas, and representative examples.
Dropped workload content is available to the active analyst, and workload data
may move through the destination named by an activated plan. Never print,
commit, or transmit secrets; do not send data beyond the activated destination.

## Goal

Create or refresh these artifacts under `.understudy/capture-evidence/`:

```text
workload-profile.md
harness.json
environment.json
metric.json
splits.json
baseline.json
```

Each artifact must include a creation timestamp, source refs or path refs, and
enough provenance for another agent to repeat the step without guessing.

## Required Checks

0. Confirm the workload profile.
   If `.understudy/capture-evidence/workload-profile.md` is missing or stale,
   route to [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md)
   before building metrics. The profile should summarize the task purpose, data
   or trace distribution, prompt/request structure, code path, tool/action
   surface, output contract, failure taxonomy, and user-confirmed success
   criteria. It may cite local paths and hashes, but should not contain raw
   private payloads unless explicitly approved.
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
     merely for not matching a teacher trace verbatim. Two grounding checks a
     shape-only schema misses, both observed in real workloads: (a) **verbatim
     evidence** — when a field claims to quote a source (transcript, doc,
     log), verify the quote appears verbatim in the source; smaller open
     models hallucinate correctly-formatted quotes; (b) **conditional
     requireds** — when an optional signal (date, flag, risk) is present, its
     evidence subfield must be present too; models that include the signal but
     drop its evidence are the dominant residual failure and usually
     prompt-fixable.
   - `rubric` — a confirmed criteria list (each criterion: id, description,
     review type); auto-generated rubrics need human approval.
   - `llm-judge` — must debias position with a swapped two-pass score
     (`(r_ab − r_ba + 2) / 4`); never single-pass.
   - `human-review` — a blind, order-randomized packet; report judge-vs-human
     agreement separately from candidate preference.
   Whatever the kind, the metric must emit **natural-language feedback that
   diagnoses why** an output failed and what to change — not just a scalar.
   For API workflow benchmarks, record final-state correctness, policy
   compliance, data accuracy, endpoint discovery, required-write completion,
   forbidden-write avoidance, unnecessary calls/retries, schema validity, and
   recoverable errors as separate axes before collapsing to an overall score.
   If the metric or validator is unclear, stop and ask one concrete question.
4. Pass the evaluation evidence gates.
   Build and confirm the coverage matrix, run harness-conformance sentinels,
   and inspect actual scored rows before interpreting aggregate results. Follow
   [`references/evaluation-evidence-gates.md`](references/evaluation-evidence-gates.md).
   An uncovered important stratum blocks a whole-workload conclusion; a failed
   read-then-write sentinel is a harness bug until proven otherwise. Keep a
   redacted local review packet with the coverage matrix, representative rows,
   counterexamples, scorer rationale, the data-sufficiency plan and stopping
   evidence, and exact artifact/log refs. Treat pilot sizes as minimums, never
   caps: when conclusions remain unstable or important strata are underfilled,
   collect more rows instead of increasing confidence in the prose.
5. Freeze splits.
   Write `splits.json` with train/dev/holdout names, sizes, source refs,
   deterministic split seed or frozen row ids, the per-stratum counts from the
   coverage matrix, uncovered strata, and an explicit "no holdout mutation"
   note.
6. Rerun the incumbent baseline.
   Use the frozen harness, metric, validator, and splits to rerun the current
   incumbent route. Write `baseline.json` with command, timestamp, split used,
   sample size, score, latency basis, cost basis if available, failures, and
   caveats. It must also include `harness_sha256`, `metric_sha256`, and
   `splits_sha256` for the exact artifacts used by the rerun.
   Record the per-row (or per-cluster) pass/fail set, not just an aggregate
   score, so the next step can see whether optimization **headroom** exists —
   i.e. rows the incumbent fails that a stronger model could fix.
   Record each per-row result as an `understudy.eval_result.v1` row — the
   required row format for eval evidence across every Understudy surface
   ([`schemas/understudy.eval_result.v1.schema.json`](../../schemas/understudy.eval_result.v1.schema.json)):
   `run_id`, `task_id`, `split`, `score` (0..1 or null — a 0 is a scored
   failure, never a missing value), `status` (`ok`/`error`/`skipped`/`unscored`),
   model, route, cost/tokens/latency when known, and a `provenance` block whose
   `harness_sha256`/`split_sha256` carry the same hash chain as `baseline.json`.

## Flow

Inspect the repo first to find where LLM calls happen and the current
model/provider/harness/eval state, then surface that inventory before building
anything. The inventory includes evidence that already exists outside the
repo: the Understudy desktop app exports benchmark comparison packets
(`understudy.fusion_benchmark_comparison.v1`) under `~/.understudy/exports/`,
each carrying `understudy.eval_result.v1` rows plus a packet-level
`provenance` block (rows in a sibling JSONL file; verify
`shasum -a 256 <provenance.eval_results_path>` equals
`provenance.eval_results_sha256` before admitting it). Surface any verified
packets in the inventory so the developer isn't asked to re-measure what the
app already measured — the admission checklist lives in
[`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md). If the request/response path, dataset/trace shape, prompt purpose, or
success criteria are not already clear, route to
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) first and
use its workload profile as the narrative source of truth. The deep inspection
checklist (call sites by SDK family, env vars, tracing, CI) and the eval-harness
discover-then-build playbook live in [`reference.md`](reference.md). For
cross-cutting objective/constraint framing, read
[`../understudy/reference.md`](../understudy/reference.md). For multi-turn /
tool-use / agentic workloads — both read-only search loops and multi-step
REST/API workflows that mutate state — route the eval to
[`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md)
instead of building a single-output harness; its state-mutating lens records
reset/seed state, API schemas, policy docs, request logs, and final-state
validators as part of the harness.

Start from the real local workload:

- app route, eval suite, trace export, benchmark fixture, prompt set, dataset,
  report, or existing runner;
- **no traces yet?** Start from a public benchmark — the golden-path ladder
  (AutomationBench, Harvey LAB) in
  [`references/public-benchmark-path.md`](references/public-benchmark-path.md)
  runs this same evidence loop against public fixtures;
- otherwise, create only a synthetic fixture and label it clearly as synthetic.

Do not optimize, tune prompts, choose replacement models, mutate splits, or
claim savings in this worker. Its job is to make the next validation step
possible.

If any artifact cannot be created, write down the missing input, the attempted
local command or inspection, and the next action most likely to unblock the
decision, with its cost and scope.

## Output Standard

End with:

- workload source inspected;
- workload profile status and whether the task understanding was confirmed;
- artifact paths created or refreshed;
- metric, validator, split boundary, and incumbent baseline status;
- result type: evidence-capture or blocked;
- one recommended next local command or action.
