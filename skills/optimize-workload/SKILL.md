---
name: optimize-workload
description: Use when a developer has a measured eval and wants the prompt or route improved without retraining — "optimize my prompt against my eval", "close the quality gap with the cheaper model", "squeeze cost without losing quality". Keeps holdout sealed, runs GEPA (automatic prompt evolution) on train/dev only, and requires a claim packet before any savings statement.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Optimize Workload

Use this worker only after the workload has fresh local artifacts from
`capture-evidence`. Validation and optimization must be evidence-led and
split-safe.

## Safety Gates

Default to the intervention with the highest expected progress toward the
objective under hard constraints, not the cheapest rung. State the expected
quality gain, time, spend envelope, and evidence before execution; follow
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture. A developer action that launches a named bounded optimization plan
authorizes its declared model calls, uploads, hosted work, evaluation, receipts,
and cleanup. Do not pause for phase-by-phase confirmation. Ask again only if the
plan expands its displayed data, destination, spend, retention, download, or
production-impact envelope. Follow the repo public boundary in
[`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md)
for prompts, completions, traces, labels, datasets, repo paths, secrets, and
private notes.

## Refusal Gate

Refuse to optimize unless all required artifacts are present and fresh:

```text
.understudy/capture-evidence/harness.json
.understudy/capture-evidence/metric.json
.understudy/capture-evidence/splits.json
.understudy/capture-evidence/baseline.json
```

Fresh means generated for the same workload, metric, split contract, and
incumbent baseline in the current task context. Freshness is hash-bound:
`baseline.json` must include `harness_sha256`, `metric_sha256`, and
`splits_sha256`, and those values must match the current `harness.json`,
`metric.json`, and `splits.json`. If freshness is ambiguous or hashes do not
match, route back to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) instead
of optimizing.

## Split Rules

- GEPA is train/dev-only.
- Prompt, route, parser, renderer, and candidate selection changes may use
  train and dev only.
- Never mutate holdout rows, labels, validators, thresholds, or sampling after
  optimization begins.
- Holdout is only for final validation after the candidate is frozen.
- If holdout is touched accidentally, mark the result contaminated and create a
  new split contract before claiming progress.

## Before You Optimize

Confirm these before spending GEPA budget — full detail, model defaults, and
validator kinds in [`reference.md`](reference.md):

- **Evidence gates** — apply the coverage, harness-conformance, qualitative
  row-review, and claim-strength gates in
  [`../capture-evidence/references/evaluation-evidence-gates.md`](../capture-evidence/references/evaluation-evidence-gates.md).
  Do not optimize a narrow easy cohort as though it represents the workload.
  Inspect the real rows behind the baseline headline and confirm important hard
  strata have train/dev and sealed-holdout representation. Treat a small pilot
  as a plumbing check only; if uncertainty, variance, or new failure classes
  remain material, collect more data before optimizing or recommending a route.

- **Headroom** — `baseline.json` must show failing-but-promptable rows. No
  incumbent failures → nothing to optimize. A strong model fails them too →
  task beyond frontier; stop.
- **Models** — student = a cheap candidate; `reflection_lm` = a strong frontier
  model (optional, but a weak one caps quality). **Inference defaults to
  Understudy** within the activated workflow:
  `understudy login --email <developer-email>`, then
  `understudy run -- <local command>`. Fall back to the developer's own
  provider keys only if they choose BYO. See reference.md → Inference.
- **Scope boundary** — optimizing the prompt, route, or parser of a workload's
  policy model is in scope, including an *agentic / tool-use* policy. Treat one
  full agent rollout as the unit and the rubric as the metric. Only RL
  *trajectory/policy training* and stateful verifier environments are out of
  scope; that is the handoff in
  [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md).
  For agentic eval/optimization, set up the rollout harness and rubric in
  [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md)
  first, then return here for the GEPA prompt pass.
- **Stopping rule** — if the scorer saturates to 1.0 fast, the surface is too
  easy; strengthen the metric, don't claim. If GEPA stalls with headroom left,
  recommend the next rung (SFT/distillation); this skill does not train.

## Flow

1. Inspect the required artifacts and confirm they describe the same workload.
2. Re-state the metric, validator, split boundary, incumbent score, latency
   basis, cost basis if available, and failure taxonomy.
3. Select the highest-leverage intervention that matches the observed failure mode:
   prompt repair, parser/schema repair, context trimming, route change,
   candidate model comparison, or GEPA. When the complaint is cost (not
   quality) and inputs dominate the bill, check prompt-cache structure first —
   it's often the cheapest lever of all:
   [`references/prompt-cache-optimization.md`](references/prompt-cache-optimization.md).
   Prefer the lowest-cost *target* only among options expected to resolve the
   failure; do not spend several weak iterations avoiding a stronger model or
   broader experiment. See [`reference.md`](reference.md) → Optimization-Target
   Menu for the full list. For an agentic workload, treat latency
   and cost per rollout as first-class objectives alongside the rubric score —
   tool-call count, redundant calls, and wasted context are common, optimizable
   failure modes, not just quality misses.
4. For GEPA/DSPy execution, use a small local `uv` environment when selected by
   the activated workflow. Do not vendor GEPA/DSPy or depend on a full private
   runtime. The CLI owns a registry-backed adapter wrapper:
   `optimize-workload adapter run --adapter <name> ... --execute`.
   `eval-input-gepa` runs upstream GEPA locally without provider calls unless a
   model-backed path is explicitly selected. `adapter run --adapter dspy-gepa
   --execute` uses exact `dspy==3.3.0`, `gepa[dspy]==0.1.1`, and
   `cloudpickle==3.1.2` packages and
   additionally requires separate student/reflection model names, an approved dollar cap, and explicit input
   and output token prices before it resolves the Understudy API key. It passes
   auth to the child process through environment only, disables client-side
   retries, and reserves each request against one cumulative price-basis ledger before
   running train/dev rows. A program bridge may bind student and reflection to
   independent credential-free routes by naming credential environment
   variables; missing mappings use the Understudy Gateway. Receipt the
   requested alias, exact executed DSPy/LiteLLM model, and only response model
   identity actually exposed. Do not infer ZDR from a route name or
   `workload_capture: false`. Treat the resulting attribution
   as a conservative cap under the supplied prices, not a provider invoice. GEPA's
   edge is natural-language feedback: the metric must return a diagnosis of
   *why* each failing row failed and what to change, not a bare score — bland
   feedback wastes the optimizer. For an agentic workload this means the
   per-criterion rubric must emit, per failing row, a short natural-language
   note tied to the rollout — e.g. "called search 6 times for a fact on the
   first result page; tighten the stop condition" or "answer omitted the date
   filter the question required; add it to the query plan" — rather than a bare
   `0`.
   Start new GEPA runs with `--num-threads 1`; use pareto selection and opt into
   merge only when the approved budget covers it. For a workload-owned program,
   first pass `--program-bridge ... --admission-only`, inspect its hashed offline
   and one-episode live receipt, then compile separately with the exact
   `--admission-receipt`. Admission must fail unless provider-free validation
   separately binds the typed input-row bundle and proves the exact endpoint
   executable bundle was loaded, typed request/expected/tool contracts passed,
   package/adapter/tool-schema hashes match, and every required write produced
   an actual world-state delta. Never score a hash-only expectation or an HTTP
   200 response that failed local parsing as model behavior. The bridge metric
   returns `ScoreWithFeedback`; its optional export callback writes a canonical,
   provenance-bound deployable bundle.
   Keep workload package/lock pins workload-scoped; never copy one workload's
   verifier/MCP bump into another workload.
5. Keep deterministic work in the TypeScript CLI and this skill's templates. Follow
   [`../../docs/optimize-workload-contract.md`](../../docs/optimize-workload-contract.md)
   for adapter, metric feedback, and claim packet details.
6. When GEPA is selected in the activated plan, run train/dev-only and
   record the command, model/deployment, metric-call budget, dollar cap, token
   price basis, reserved upper bound, attributed usage, seed, selected
   candidate, rejected variants when available, and whether provider calls were
   made through Understudy.
7. Freeze the candidate before any holdout validation.
8. Run holdout only once the candidate is frozen, and record score, failures,
   latency basis, cost basis, fallback route, demotion trigger, and caveats.
   Inspect the actual rows behind material deltas before naming a win. A narrow
   first pass that improves train/dev but regresses holdout is an overfitting
   diagnosis, not evidence to iterate on the sealed rows; expand or rebalance a
   new split contract and start a fresh experiment.

The home of record for an optimization run is the **active experiment**
directory (see the Experiment section of
[`../understudy/SKILL.md`](../understudy/SKILL.md) for the record shape):

```text
.understudy/experiments/<exp-id>/      # experiment.json, candidate.json, claim.json
```

Open or reuse an experiment before optimizing with `understudy experiments new`
(it pins the current baseline); `experiments/active` names it. On
`optimize-workload adapter run --execute` the produced candidate is frozen into
the active experiment directory automatically; `understudy experiments freeze`
does it explicitly and also freezes a `--claim-from <path>`. The optimizer's
working artifacts (`eval-input-candidate.json`, `proof-packet.json`, adapter
outputs) stay under `.understudy/optimize-workload/`. Run `understudy next` to
see the current loop step.

The previous Python helper scripts have been removed with the Python CLI
prototype. Use the TypeScript CLI gates first, and still inspect artifacts
directly when a workload has unusual validator, split, or claim-boundary shape.
Block on stale hashes, missing metric feedback, unapproved provider calls, or
proxy-only validation.

Use the CLI guide before creating a local optimizer env:

```bash
understudy skills --search gepa
understudy optimize-workload adapter run --repo . --adapter eval-input-gepa --manifest eval-input-manifest.json --execute
```

If approved, let the named adapter create its exact ignored `uv` runtime:

```bash
understudy optimize-workload adapter run --repo . --adapter dspy-gepa --help
```

Do not preinstall a floating DSPy/GEPA environment; the adapter pins and
receipts its compatible package pair.

## Claim Rules

Do not claim savings without:

```text
.understudy/experiments/<exp-id>/claim.json
```

`claim.json` must cite `harness.json`, `metric.json`, `splits.json`,
`baseline.json`, and the frozen candidate artifact. It must include the same
`harness_sha256`, `metric_sha256`, and `splits_sha256` values from the
baseline contract, plus `baseline_sha256` and the frozen candidate hash. It
must also include sample size, split used, score delta, latency basis, cost
basis, price assumptions, request-volume assumption, confidence level, caveats,
fallback route, and demotion trigger. Two rigor fields are also required
(see [`../../docs/benchmark-rigor.md`](../../docs/benchmark-rigor.md)): the
trivial-agent floor from `baseline.json` (`null_floor` — the claim is invalid
if a do-nothing agent also clears the bar), and a bootstrap confidence
interval over per-row holdout scores for both baseline and candidate — if the
intervals overlap, report an optimization lead, not a win. For an agentic workload, latency and cost
basis are per-rollout and mandatory, not optional: report the delta in tool-call
count and end-to-end rollout cost alongside the rubric delta, so a quality gain
bought with more calls or higher latency is visible rather than hidden.

Per-row eval evidence behind any claim — the baseline rerun, dev-set
comparisons, and the frozen-candidate holdout table — must be recorded as
`understudy.eval_result.v1` rows
([`schemas/understudy.eval_result.v1.schema.json`](../../schemas/understudy.eval_result.v1.schema.json)).
The row-level `provenance.harness_sha256` and `provenance.split_sha256` fields
carry the same hash chain the claim packet cites, a `score` of 0 is a scored
failure (never a missing value), and `unscored` rows are excluded from
averages rather than counted as 0.

No claim may imply replacement readiness, production readiness, or recurring
savings unless those fields are present and the holdout evidence supports the
statement. If the evidence is train/dev-only, call it an optimization lead, not
a win.

## Output Standard

End with:

- required artifacts inspected and freshness status;
- validation or optimization run;
- split used and whether holdout remained untouched;
- candidate status and whether `claim.json` exists;
- result type: validation, optimization, heldout, or blocked;
- one recommended next local command or action.
