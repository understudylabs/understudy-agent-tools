# Agentic Rollout GEPA Adapter

Use this pattern when prompt optimization must be scored by a live, multi-step
tool harness instead of flat prompt-to-output rows.

The public CLI adapters are intentionally narrow:

- `eval-input-gepa` optimizes flat rows with local metric functions.
- `dspy-gepa` optimizes DSPy-style samples.

For an AutomationBench-style workload, the faithful adapter wraps the benchmark:

1. Candidate state is a small component map, usually `{ "system_prompt": "..." }`.
2. `evaluate(batch, candidate)` writes the candidate prompt to a local env var or
   prompt file and runs the harness on train/dev rows only.
3. The harness command exports JSON, for example:

   ```sh
   AB_SIMPLE_SYSTEM_PROMPT="$CANDIDATE_PROMPT" \
   uv run auto-bench \
     --model "$LOCAL_MODEL" \
     --base-url http://127.0.0.1:8081/v1 \
     --api-key local \
     --api chat_completions \
     --domains simple \
     --toolset limited_zapier \
     --tasks "$TASKS" \
     --export-json "$EXPORT_JSON"
   ```

4. The adapter parses the export into scores and per-row failure feedback:
   wrong endpoint, missing write, forbidden write, invalid schema, empty response,
   bad recovery, or final-state diff.
5. Reflection uses an approved model and explicit spend cap. Student rollouts stay
   local when the student endpoint is local.
6. Holdout rows are never passed to GEPA. They are run once after the winning
   candidate is frozen.

For API workflows, first ask whether a cheaper structural target is enough:

- If `api` or `zapier` fails but `limited_zapier` succeeds, optimize retrieval or
  endpoint catalog selection before prompt mutation.
- If the right tools are present and the model still misses writes, policies, or
  schemas, prompt GEPA has real signal.

Record the adapter path, prompt hook, task ids, train/dev split, reflection model,
spend cap, and final candidate in `.understudy/capture-evidence/`.
