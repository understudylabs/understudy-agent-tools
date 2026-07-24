---
name: compare-model-sweep
description: Use when a developer wants to compare candidate models — any mix of local, gateway, or frontier — on the same eval and see quality, latency, cost, and reliability side by side. "Which model should I use", "sweep these models on my benchmark", "compare Gemma vs the frontier on my eval". To stand up and serve a local candidate first, use run-local-model-lab.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: false
---

# Compare Model Sweep

Use this worker when the question is not "can one model pass this eval?" but
"which candidate sits on the useful frontier for this workload?" The skill runs
one frozen harness across a candidate matrix, records each run, and emits a
decision-ready Pareto report an agent can use for route decisions.

Prefer this after [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md),
[`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md), or
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) has already
identified a resettable eval and a first local candidate.

## Safety Gates

Launching a named bounded sweep authorizes its declared provider calls, uploads,
benchmark rows, evaluation, receipts, and cleanup. Ask again only if the sweep
expands its displayed data, destination, spend, retention, download, or
production-impact envelope. Never place private traces or customer data in a
public sweep report.

Recommend a candidate matrix sized to resolve the objective, including a strong
anchor when it could change the decision. Present expected spend and wall-clock
before the run and follow
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture. Do not omit the informative candidate merely to keep the first sweep
cheap; one activated plan covers the whole named matrix.

Do not claim a model is cheaper, faster, or better unless the sweep used the same
rows, harness, metric, tool-access mode, prompt, seed, and state reset for every
candidate.
If those differ, label the result as an ablation or diagnostic, not a Pareto
comparison.

## Flow

1. **Freeze the comparison contract.** Record workload id, harness command,
   split/row ids, metric, prompt, tool-access mode, seed, timeout, concurrency,
   and budget.
   Write it to `.understudy/model-sweeps/<timestamp>/sweep-plan.json`.

2. **Normalize candidate routes.** Include each model id, route type
   (`local`, `understudy-managed-catalog`, `understudy-routed`,
   `byo-provider`, or `hosted-other`), endpoint/base URL, loader/runtime,
   local-vs-remote boundary, max tokens, reasoning effort, pricing basis, and
   whether the model is cached or requires download.

   For remote Understudy candidates, run `understudy models list --json`;
   prefer managed-catalog ids unless BYO provider-direct behavior is required.
3. **Run conformance smoke first.** Each candidate must complete one row without
   connection errors, empty responses, or bad model aliases. For agentic
   workloads, also run a synthetic read-then-write sentinel through the exact
   driver and parser: execute the read, append its result, continue, execute the
   write, and score final state. Never score an intermediate tool call as a
   no-op. For local MLX, prefer verified filesystem paths or Understudy snapshot
   aliases over arbitrary Hugging Face ids. Apply the shared gates in
   [`../capture-evidence/references/evaluation-evidence-gates.md`](../capture-evidence/references/evaluation-evidence-gates.md).
   The smoke row proves only that the harness runs; it provides no model-quality
   evidence.

4. **Run the frozen matrix.** Call the same harness once per candidate with the
   same rows, split, tool-access mode, prompt, seed, and export path. Keep each
   export under `.understudy/model-sweeps/<timestamp>/candidate-runs/<candidate>/`,
   with per-row results in the required `understudy.eval_result.v1` eval-evidence format ([schema](../../schemas/understudy.eval_result.v1.schema.json)).

   **Benchmark-dir sweeps run as arms of one request.** When the frozen eval
   is a trace-compiled benchmark directory, don't hand-loop the harness:
   queue one `understudy.run_request.v1` whose arms are the whole matrix —
   candidate models, the incumbent (`incumbent_models`, feeding
   `calibration.json`), the trivial floors
   (`trivial_arms: ["null_agent", "spam_agent"]` — a candidate beating a
   floor-exceeded benchmark proves nothing), and prompt experiments as
   `prompt_overrides` arms — and let `understudy runs execute` score them all
   through the identical contract scorer. Operating manual:
   [`../operate-benchmark-lab/SKILL.md`](../operate-benchmark-lab/SKILL.md).
   A built-in Pareto view and CSV export over these rows are landing now in
   the hub; until they ship, project `rows-*.jsonl` into `summary.csv` /
   `pareto.json` yourself per steps 5–7.

5. **Summarize at the same grain.** Build `summary.csv` with candidate, route,
   route type, requested model, effective model, model family, tool-access mode,
   task count, pass rate, partial credit, total tokens, cost/task, run seconds,
   errors, empty responses, and caveats. If per-task latency is unavailable, use
   run-level duration and say so.

   For Understudy gateway runs, capture `x-understudy-mode`,
   `x-understudy-route`, and `x-understudy-effective-model`; exclude rows where
   requested and effective model disagree unless that is the test.

   **Caching parity.** Cost columns must state each candidate's caching basis.
   If the incumbent runs cache-warmed in production (e.g. a cached primer),
   measure same-provider candidates cache-warmed too; when a candidate has no
   equivalent cache layer (a different provider or gateway can't share the
   incumbent's cache pool), measure it uncached and label it — what you
   measured is what they'd pay. Note that batching or longer cache TTLs shift
   absolute costs on the cached side but should not change the ratios. To
   structure the harness itself for cache hits (and avoid the
   parallel-fan-out all-miss trap), see
   [`optimize-workload/references/prompt-cache-optimization.md`](../optimize-workload/references/prompt-cache-optimization.md).

   **Pairwise option.** When the workload has no programmatic metric
   (open-ended generation), score quality as a pairwise preference against the
   incumbent instead of an absolute rubric: same row, two outputs, an LLM
   judge picks A/B/tie — run **twice with the order swapped** and count a win
   only when both passes agree. Report the debiased win-rate with N. Dry-run
   the judge on a few rows first, budget-gate the live judge like any provider
   spend, and keep judge-scored quality as its own column — never silently
   blended with a programmatic metric.

   Before explaining any aggregate delta, inspect the actual rows behind one
   pass, each reported failure class, each surprising delta, and a counterexample
   to the proposed conclusion. Distinguish model behavior from equivalent
   free-text wording, scorer/rubric errors, labels, and harness/parser failures.
   Scope conclusions to represented coverage strata.

6. **Quantify uncertainty against a prespecified decision rule.** Point
   estimates on a small N are not a ranking. For each candidate, report N,
   per-task variance, and a bootstrap confidence interval over its aggregate
   score. When candidates ran on the same rows, make the decision from the
   paired per-row deltas: bootstrap the row-aligned deltas (≥1,000 resamples)
   and report their 2.5/97.5 percentiles. Marginal candidate intervals remain
   descriptive; their overlap or non-overlap is not a hypothesis test of the
   difference.

   Prespecify the decision that matches the workload:

   - **superiority:** the paired-delta interval clears the superiority threshold;
   - **non-inferiority:** its lower bound clears the workload's maximum
     acceptable quality regression;
   - **equivalence:** the full interval lies inside the prespecified equivalence
     band;
   - **multi-objective route decision:** the candidate satisfies every hard
     contract/safety constraint and maximizes the prespecified utility or
     lexicographic objective across quality, cost, latency, and reliability.

   If rows are not pairable, state that limitation and use an appropriate
   independent-sample interval/test or gather paired rows. Never relabel an
   inconclusive superiority result as quality improvement. A route may still be
   selected on cost/latency after demonstrated quality non-inferiority, or by a
   prespecified multi-objective utility rule, with that basis stated explicitly.
   This follows the Agentic Benchmark Checklist's reporting bar
   ([uiuc-kang-lab/agentic-benchmarks](https://github.com/uiuc-kang-lab/agentic-benchmarks));
   see [`../../docs/benchmark-rigor.md`](../../docs/benchmark-rigor.md).

7. **Compute the decision frontier.** Record workload-specific
   acceptable-regression/non-inferiority bands and mark developer-specified
   contract and safety requirements as hard constraints. Exclude candidates
   that violate a hard constraint. Among eligible candidates, a route is
   dominated when another has decision-supported equal or better quality and
   equal or lower cost and latency, with no worse error rate or safety result.
   Write `pareto.json` with bands, hard-constraint outcomes, decision rule, and
   dominated reasons.

8. **Report the decision.** Write `report.md` with the top frontier candidates,
   the best route for the agreed objective and constraints, and the next action:
   ship route, build retrieval/tooling, run GEPA, climb local model, or use remote.
   Candidate quality cells must come from measured rows or say `not run`;
   plausible projections are never substitutes. Include the coverage matrix and
   a redacted row-review packet. If the result is unstable across batches,
   underpowered for the material difference, or still exposing new failure
   classes, expand the frozen matrix before recommending a route. Use a
   visualization only when it answers a named decision question better than the
   results table.

## Harness Pattern

Use the workload harness's JSON exports directly. Keep the command concrete in
`sweep-plan.json`, but avoid changing anything except the candidate route:

```sh
"$HARNESS_CMD" \
  --model "$MODEL" \
  --endpoint "$ENDPOINT" \
  --rows "$ROWS" \
  --tool-access "$TOOL_ACCESS" \
  --export-json ".understudy/model-sweeps/$RUN/candidate-runs/$ID/results.json"
```

For keyless managed-catalog sweeps, use one cleared/no-route workload and vary
only request-body `model`. Do not use a traffic split unless the non-routed
passthrough share has a managed provider credential or BYO key.

For API-workflow sweeps, keep tool-access interpretation explicit:

- Broad or production tool access is the deployable baseline.
- Curated, narrow, or oracle tool access is diagnostic unless a retriever or
  advisor is being evaluated and scored separately.

## Output Standard

End with the sweep path, candidate count, split size, quality/cost/latency axes,
which candidates are on the frontier, which are dominated, and the recommended
next action.

When the sweep informs a real route decision, also write the report as a
**decision memo** the developer can paste to their team unedited:

- a results table: candidate, pass rate against the production validator
  (with its bootstrap CI and N), paired quality delta against the decision
  baseline with its interval, and the prespecified superiority,
  non-inferiority, equivalence, or utility verdict,
  total cost, cost per unit of work the business counts (per deal, per ticket,
  per call — not per token), and the cost ratio vs the incumbent;
- caching basis per row (see step 5) and any other comparability caveats;
- where the residual failures cluster, as named patterns with the
  highest-leverage supported fix per pattern (prompt line, decode/format fix,
  decomposition, route fallback);
- a staged recommendation: the drop-in safe swap, the parallel pilot, and the
  highest-information iteration, rather than one all-or-nothing verdict;
- a scope line: what fraction of the workload's total LLM cost this step
  represents, and what's next if the approach extends;
- one headline the finance owner can multiply by volume ("saves ~$X per
  <unit>; multiply by monthly volume").

If the verdict supports changing production traffic, hand off to
[`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md): add the provider,
set the route, and ramp staged traffic gated by the same production validator
the sweep used.

Detailed row-review packet guidance lives in [`reference.md`](reference.md).
