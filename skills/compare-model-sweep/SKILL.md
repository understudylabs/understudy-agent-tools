---
name: compare-model-sweep
description: Use when a developer wants to compare candidate models — any mix of local, gateway, or frontier — on the same eval and see quality, latency, cost, and reliability side by side. "Which model should I use", "sweep these models on my benchmark", "compare Gemma vs the frontier on my eval". To stand up and serve a local candidate first, use run-local-model-lab.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Compare Model Sweep

Use this worker when the question is not "can one model pass this eval?" but
"which candidate sits on the useful frontier for this workload?" The skill runs
one frozen harness across a candidate matrix, records each run, and emits a
small Pareto report an agent can use for route decisions.

Prefer this after [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md),
[`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md), or
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) has already
identified a resettable eval and a first local candidate.

## Safety Gates

Get explicit approval before provider spend, remote gateway calls, benchmark
submissions, uploads, or new model downloads. Local cached model runs are fine
when the user has already approved the local harness. Never mix private traces or
customer data into a public sweep report; use synthetic, anonymized, or local-only
artifacts.

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

2. **Normalize candidate routes.** Include each model id, endpoint/base URL,
   loader/runtime, local-vs-remote boundary, max tokens, reasoning effort,
   pricing basis, and whether the model is cached or requires download.

3. **Run a smoke row first.** Each candidate must complete one row without
   connection errors, empty responses, or bad model aliases. For local MLX, prefer
   verified filesystem paths or Understudy snapshot aliases over arbitrary
   Hugging Face ids.

4. **Run the frozen matrix.** Call the same harness once per candidate with the
   same rows, split, tool-access mode, prompt, seed, and export path. Keep each
   export under
   `.understudy/model-sweeps/<timestamp>/candidate-runs/<candidate>/`.

5. **Summarize at the same grain.** Build `summary.csv` with candidate, route,
   model family, tool-access mode, task count, pass rate, partial credit, total
   tokens, cost/task, run seconds, errors, empty responses, and caveats. If
   per-task latency is unavailable, use run-level duration and say so.

   **Caching parity.** Cost columns must state each candidate's caching basis.
   If the incumbent runs cache-warmed in production (e.g. a cached primer),
   measure same-provider candidates cache-warmed too; when a candidate has no
   equivalent cache layer (a different provider or gateway can't share the
   incumbent's cache pool), measure it uncached and label it — what you
   measured is what they'd pay. Note that batching or longer cache TTLs shift
   absolute costs on the cached side but should not change the ratios.

   **Pairwise option.** When the workload has no programmatic metric
   (open-ended generation), score quality as a pairwise preference against the
   incumbent instead of an absolute rubric: same row, two outputs, an LLM
   judge picks A/B/tie — run **twice with the order swapped** and count a win
   only when both passes agree. Report the debiased win-rate with N. Dry-run
   the judge on a few rows first, budget-gate the live judge like any provider
   spend, and keep judge-scored quality as its own column — never silently
   blended with a programmatic metric.

6. **Compute the frontier.** A candidate is dominated when another candidate has
   equal or better quality and equal or lower cost and latency, with no worse
   error rate or safety result. Write `pareto.json` with dominated reasons.

7. **Report the decision.** Write `report.md` with the top frontier candidates,
   the cheapest acceptable model at the agreed quality floor, and the next action:
   ship route, build retrieval/tooling, run GEPA, climb local model, or use remote.

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

- a results table: candidate, pass rate against the production validator,
  total cost, cost per unit of work the business counts (per deal, per ticket,
  per call — not per token), and the cost ratio vs the incumbent;
- caching basis per row (see step 5) and any other comparability caveats;
- where the residual failures cluster, as named patterns with the cheapest fix
  per pattern (prompt line, decode/format fix, decomposition, route fallback);
- a staged recommendation: the drop-in safe swap, the parallel pilot, and the
  cheap iteration, rather than one all-or-nothing verdict;
- a scope line: what fraction of the workload's total LLM cost this step
  represents, and what's next if the approach extends;
- one headline the finance owner can multiply by volume ("saves ~$X per
  <unit>; multiply by monthly volume").

If the verdict supports changing production traffic, hand off to
[`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md): add the provider,
set the route, and ramp staged traffic gated by the same production validator
the sweep used.
