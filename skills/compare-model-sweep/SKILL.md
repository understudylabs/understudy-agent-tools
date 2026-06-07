---
name: compare-model-sweep
description: Use when a developer wants to run the same eval or benchmark across multiple local, gateway, or frontier models and produce a Pareto-style quality, latency, cost, and reliability comparison.
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
[`../optimize-api-workflow/SKILL.md`](../optimize-api-workflow/SKILL.md), or
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) has already
identified a resettable eval and a first local candidate.

## Safety Gates

Get explicit approval before provider spend, remote gateway calls, benchmark
submissions, uploads, or new model downloads. Local cached model runs are fine
when the user has already approved the local harness. Never mix private traces or
customer data into a public sweep report; use synthetic, anonymized, or local-only
artifacts.

Do not claim a model is cheaper, faster, or better unless the sweep used the same
rows, harness, metric, toolset, prompt, seed, and state reset for every candidate.
If those differ, label the result as an ablation or diagnostic, not a Pareto
comparison.

## Flow

1. **Freeze the comparison contract.** Record workload id, harness command,
   split/row ids, metric, prompt, toolset, seed, timeout, concurrency, and budget.
   Write it to `.understudy/model-sweeps/<timestamp>/sweep-plan.json`.

2. **Normalize candidate routes.** Include each model id, endpoint/base URL,
   loader/runtime, local-vs-remote boundary, max tokens, reasoning effort,
   pricing basis, and whether the model is cached or requires download.

3. **Run a smoke row first.** Each candidate must complete one row without
   connection errors, empty responses, or bad model aliases. For local MLX, prefer
   verified filesystem paths or Understudy snapshot aliases over arbitrary
   Hugging Face ids.

4. **Run the frozen matrix.** For AutomationBench, call `auto-bench` once per
   candidate with the same `--domains`, `--tasks` or `--num-examples`,
   `--toolset`, and `--export-json`. Keep each export under
   `.understudy/model-sweeps/<timestamp>/candidate-runs/<candidate>/`.

5. **Summarize at the same grain.** Build `summary.csv` with candidate, route,
   model family, toolset, task count, pass rate, partial credit, total tokens,
   cost/task, run seconds, errors, empty responses, and caveats. If per-task
   latency is unavailable, use run-level duration and say so.

6. **Compute the frontier.** A candidate is dominated when another candidate has
   equal or better quality and equal or lower cost and latency, with no worse
   error rate or safety result. Write `pareto.json` with dominated reasons.

7. **Report the decision.** Write `report.md` with the top frontier candidates,
   the cheapest acceptable model at the agreed quality floor, and the next action:
   ship route, build retrieval/tooling, run GEPA, climb local model, or use remote.

## AutomationBench Pattern

Use AutomationBench's JSON exports directly:

```sh
uv run auto-bench \
  --model "$MODEL" \
  --base-url "$BASE_URL" \
  --api-key "$API_KEY" \
  --api chat_completions \
  --domains simple \
  --toolset api \
  --tasks "$TASKS" \
  --export-json ".understudy/model-sweeps/$RUN/candidate-runs/$ID/results.json"
```

For API-workflow sweeps, keep toolset interpretation explicit:

- `api` and `zapier` are realistic tool-discovery comparisons.
- `limited_zapier` is an oracle-tool diagnostic unless a retriever/advisor is
  being evaluated and scored separately.

## Output Standard

End with the sweep path, candidate count, split size, quality/cost/latency axes,
which candidates are on the frontier, which are dominated, and the recommended
next action.
