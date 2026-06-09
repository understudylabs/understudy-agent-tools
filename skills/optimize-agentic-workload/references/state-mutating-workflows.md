# State-mutating API workflows — harness reference

Deep detail for [`SKILL.md`](../SKILL.md), for the **state-mutating** lens: a
multi-step LLM or agent loop that reads task instructions and policy docs,
discovers or selects REST endpoints, performs writes across one or more business
systems, and is judged by final state plus policy compliance. Use this reference
when wiring a resettable API workflow into the Understudy artifact contract,
measuring a baseline, and comparing model, route, prompt, tool-access, or parser
candidates.

All examples here are synthetic. Use local fixtures or benchmark sandboxes unless
the developer explicitly approves provider spend, hosted execution, uploads, or
live API writes.

## Why API Workflows Are Different

A single-output workload is one prompt and one scored completion. An API workflow
is one task instruction followed by a full rollout: the policy model reads task
and policy context, chooses endpoints, emits API calls, observes responses,
continues or recovers, and leaves a final state. The unit of evaluation is the
**whole rollout**, not the final text.

Three consequences shape the playbook:

- Correctness is stateful. The final database or service state matters more than
  matching a teacher trace.
- Safety is first-class. A high final score with forbidden writes, invalid
  schemas, or excessive retries is not a win.
- Determinism comes from the harness. Seeded initial state, fixed API schemas,
  fixed policy docs, and final-state validators make API workflow evals more
  reproducible than live agentic search.

## When This Lens Applies

- the agent performs a multi-step API workflow, not a single prompt response;
- tools are REST, OpenAPI, RPC, or SDK calls with observable state changes;
- success requires final-state correctness and policy adherence;
- the harness can reset or seed state before each task;
- candidates should be compared on quality, latency, cost, and side-effect
  safety.

If there is no resettable state or validator, route back to
[`../../capture-evidence/SKILL.md`](../../capture-evidence/SKILL.md) first.

## Artifact Bridge

Write the standard evidence files under `.understudy/capture-evidence/`. These
examples are intentionally small and synthetic.

For API workflows, `harness.json` must include the reset command, seed fixture,
task source, API schema or service map, allowed endpoint set, policy-doc refs,
agent entrypoint, request-log path, final-state validator, timeout, and network
boundary. `environment.json` must record the local service versions, mock server
or sandbox setup, required env var names without values, and whether any route
can write to live systems.

### `harness.json` — runnable rollout harness

Record the command that runs one or more full workflow rollouts. `${MODEL}` is
the slot that changes during A/B; the task set, seeded state, API schema, policy
docs, validator, and network boundary stay fixed.

```json
{
  "schema_version": "understudy.harness.v1",
  "kind": "api-workflow-rollout",
  "benchmark": "local-or-public-sandbox",
  "command": "${HARNESS_CMD} --model ${MODEL} --rows ${ROWS} --export-json ${EXPORT_JSON}",
  "agent_entrypoint": "${HARNESS_CMD}",
  "policy_model_slot": "${MODEL}",
  "task_source": "synthetic-api-workflow",
  "api_schema": {
    "kind": "openapi",
    "path": ".understudy/capture-evidence/api-schema.json"
  },
  "policy_docs": [".understudy/capture-evidence/policy.md"],
  "seeded_state": {
    "reset_command": "${HARNESS_CMD} reset --seed ${SEED}",
    "seed": 7,
    "state_fixture": ".understudy/capture-evidence/seed-state.json"
  },
  "allowed_endpoints": ["GET /records", "POST /records", "PATCH /records/{id}"],
  "request_log": ".understudy/capture-evidence/request-log.jsonl",
  "final_state_validator": {
    "kind": "command",
    "command": "${HARNESS_CMD} validate --export-json ${EXPORT_JSON}"
  },
  "timeout_s": 300,
  "network_boundary": "benchmark-sandbox"
}
```

If the harness command is unavailable in the current repo, do not invent a
replacement command. Record the missing command as a blocker and keep the rest
of the artifact draft local.

### `environment.json` — resettable sandbox

```json
{
  "schema_version": "understudy.environment.v1",
  "kind": "api-workflow-sandbox",
  "services": [
    {
      "name": "synthetic-crm",
      "version": "fixture-v1",
      "base_url": "http://127.0.0.1:8123",
      "writes_live_system": false
    }
  ],
  "runtime": {
    "command_runner": "uv",
    "python": "managed-by-uv",
    "timezone": "UTC"
  },
  "required_env": ["UNDERSTUDY_API_KEY"],
  "secret_values_recorded": false,
  "network": "local-or-benchmark-sandbox",
  "resettable": true
}
```

### `metric.json` — rollout score plus feedback

Quality is a weighted API-workflow rubric, not a generic answer score. Include
final-state correctness, policy compliance, data accuracy, endpoint discovery,
required-write completion, forbidden-write avoidance, unnecessary calls/retries,
schema validity, and recoverable errors. Latency and cost are per workflow
rollout. Map the harness's primary pass/fail field to final-state correctness
and its graded score to the weighted rubric. The rubric must emit
natural-language feedback tied to the failing step, endpoint, invariant, or
state diff.

```json
{
  "schema_version": "understudy.metric.v1",
  "approved": true,
  "validator": {
    "kind": "api-workflow-rubric",
    "source": "harness-export",
    "feedback_required": true
  },
  "objectives": {
    "quality": {
      "primary": "task_completed_correctly",
      "partial_credit": "partial_credit",
      "criteria": [
        { "id": "final_state_correct", "weight": 0.30 },
        { "id": "policy_compliance", "weight": 0.15 },
        { "id": "data_accuracy", "weight": 0.15 },
        { "id": "endpoint_selection", "weight": 0.10 },
        { "id": "required_writes_completed", "weight": 0.10 },
        { "id": "forbidden_writes_avoided", "weight": 0.10 },
        { "id": "unnecessary_calls_avoided", "weight": 0.04 },
        { "id": "schema_validity", "weight": 0.04 },
        { "id": "recoverable_error_handling", "weight": 0.02 }
      ]
    },
    "latency": {
      "source": "rollout",
      "fields": ["wall_clock_s", "api_call_count"]
    },
    "cost": {
      "source": "rollout",
      "fields": ["prompt_tokens", "completion_tokens", "api_call_count"],
      "price_assumption": "recorded-per-run"
    },
    "side_effect_safety": {
      "source": "request-log",
      "fields": ["forbidden_write_count", "invalid_request_count", "retry_count"]
    }
  },
  "acceptable_regression": {
    "task_completed_correctly": 0,
    "partial_credit": -0.02,
    "forbidden_write_count": 0
  }
}
```

### `splits.json` — task freeze

Use domains, workflow families, customer segments, or row ids as split units
when they expose meaningful distribution shift. Keep holdout groups or rows
untouched after the first baseline.

```json
{
  "schema_version": "understudy.splits.v1",
  "source": "synthetic-api-workflow",
  "seed": 7,
  "split_strategy": "domain-and-row-id",
  "train": {
    "domains": ["sales", "marketing"],
    "rows": ["sales-001", "sales-002", "marketing-001"]
  },
  "dev": {
    "domains": ["finance"],
    "rows": ["finance-001", "finance-002"]
  },
  "holdout": {
    "domains": ["support"],
    "rows": ["support-001", "support-002"]
  },
  "holdout_rule": "no mutation of holdout rows, labels, seeded state, policy docs, API schemas, or thresholds after optimization begins"
}
```

### `baseline.json` — incumbent rollout

```json
{
  "schema_version": "understudy.baseline.v1",
  "command": "understudy run -- ${HARNESS_CMD} --model incumbent-model-id --rows dev.jsonl --export-json .understudy/capture-evidence/baseline-export.json",
  "split": "dev",
  "sample_size": 8,
  "quality": {
    "task_completed_correctly_rate": 0.625,
    "partial_credit_mean": 0.78
  },
  "latency_s_median": 12.4,
  "avg_api_call_count": 7.1,
  "cost_per_task_usd": 0.018,
  "side_effect_safety": {
    "forbidden_write_count": 0,
    "invalid_request_count": 2,
    "retry_count": 5
  },
  "per_task": [
    {
      "id": "finance-001",
      "domain": "finance",
      "task_completed_correctly": true,
      "partial_credit": 1,
      "api_call_count": 5,
      "feedback": "Completed required update and avoided unrelated records."
    }
  ],
  "request_log_summary": ".understudy/capture-evidence/request-log-summary.json",
  "export_json": ".understudy/capture-evidence/baseline-export.json",
  "harness_sha256": "<sha>",
  "metric_sha256": "<sha>",
  "splits_sha256": "<sha>"
}
```

## Harness Command Mapping

Use the existing benchmark, eval, or local runner as the harness instead of
inventing a new CLI surface:

```sh
"$HARNESS_CMD" \
  --model <model-id> \
  --rows dev.jsonl \
  --tool-access production \
  --export-json .understudy/capture-evidence/<run-name>.json
```

Map flags and export fields into artifacts:

| Command / export field | Artifact field |
| --- | --- |
| `--model <model-id>` | `harness.policy_model_slot`, `baseline.command`, candidate model id |
| row, domain, or task selector | `splits.train`, `splits.dev`, or `splits.holdout` |
| example/task count | `baseline.sample_size`, candidate sample size |
| tool-access selector | `harness.tool_access_mode`, candidate caveats |
| `--export-json <path>` | `baseline.export_json`, candidate artifact path |
| primary pass/fail field | `metric.objectives.quality.primary`, `baseline.quality.task_completed_correctly_rate` |
| graded score field | `metric.objectives.quality.partial_credit`, `baseline.quality.partial_credit_mean` |
| request/tool trace | `harness.request_log`, `baseline.request_log_summary` |
| seeded state/reset metadata | `harness.seeded_state`, `environment.resettable` |

Seeded state is the determinism guarantee. Prefer an existing resettable
benchmark or sandbox over hand-rolled mocks when available; the agent should
record the seed and reset command, then run every candidate against the same rows
and state.

### Tool-Access Reporting

Separate tool discovery from task execution. For small/local models, first ask
whether the failure is "could not find the right tool" rather than "could not do
the task." Most API-workflow harnesses can expose materially different tool
surfaces. Keep those surfaces explicit because they support different claims:

| Tool-access mode | What it measures | Claim status |
| --- | --- | --- |
| Broad production access | Discovery or selection over the deployable API/tool catalog | Realistic baseline |
| Structured retrieval access | Search, ranking, or advisor selection over the catalog | Realistic if the retriever is deployable |
| Curated or oracle access | Relevant tools supplied from labels, fixtures, or a narrow test slice | Diagnostic only unless the curator is deployable |

Always report a realistic tool-access number beside any curated or oracle-tool
result. An oracle-tool win proves the model can execute the task once discovery
is solved; it does not prove a deployable route unless a real retriever or
advisor supplies the same tool subset without looking at labels. Treat
oracle-tool matching as a diagnostic or advisor-training target, not as a
route-superiority claim.

For small local models, treat the spread between realistic tool access and
curated/oracle tool access as the tool-retrieval opportunity. A useful advisor
report should include recall, precision, exact-set match, catalog size, target
tool count distribution, latency, and whether the catalog prefix is byte-stable
enough for prompt caching.

## Workload Card Fill Values

When `capture-evidence` produces a mostly-null workload card, fill the known API
workflow semantics before registering or routing it:

```json
{
  "schema_version": "understudy.workload_card.v1",
  "workload_id": "api-workflow-eval",
  "workload_name": "API workflow eval",
  "workload_shape": ["api-workflow", "multi-step-rollout", "stateful-tools"],
  "data_class": "synthetic-or-local-sandbox-state",
  "success_metric": "task_completed_correctly_rate with partial_credit_mean and side-effect safety",
  "validator": {
    "type": "final-state-plus-policy-rubric",
    "artifact": ".understudy/capture-evidence/metric.json"
  },
  "harness": {
    "command": "${HARNESS_CMD} --model ${MODEL} --rows ${ROWS} --export-json ${EXPORT_JSON}",
    "artifact": ".understudy/capture-evidence/harness.json"
  },
  "baseline": {
    "model": "incumbent-model-id",
    "artifact": ".understudy/capture-evidence/baseline.json"
  }
}
```

Keep `baseline.model` factual. If the incumbent is unknown, write
`"unknown-pending-baseline"` and do not claim an optimization result.

## Model A/B Procedure

For API workflows, A/B is simpler than live traffic routing: run the same
harness rows twice with only the candidate route changed.

```sh
understudy run -- "$HARNESS_CMD" \
  --model incumbent-model-id \
  --rows dev.jsonl \
  --export-json .understudy/capture-evidence/baseline-incumbent.json

understudy run -- "$HARNESS_CMD" \
  --model candidate-model-id \
  --rows dev.jsonl \
  --export-json .understudy/capture-evidence/candidate-local.json
```

Compare:

- `task_completed_correctly_rate`
- `partial_credit_mean`
- forbidden writes and invalid requests
- p50/p95 rollout latency
- total token cost per task
- API call count and retry count

Pick the cheapest model that stays within the approved regression band and does
not increase unsafe side effects. If both models fail the same invariant, the
next intervention is prompt/tool-description repair, not another blind model
swap.

## GEPA Bridge For Multi-Step Rollouts

GEPA can still be used, but the training example is a rollout case:

- `prompt` = task instruction plus the frozen policy/API context that the agent
  sees before acting.
- `completion` = the serialized action trajectory and final answer/status, not a
  single natural-language answer.
- `score` = rubric score from `metric.json`.
- `feedback` = validator feedback describing the first meaningful failure:
  wrong endpoint, missing required write, forbidden write, bad schema, bad
  recovery, or final-state diff.

GEPA must use train/dev only. Holdout remains sealed until the candidate prompt
or route is frozen.

Minimal manifest shape for a future adapter:

```json
{
  "schema_version": "understudy.eval_input_manifest.v1",
  "kind": "api-workflow-rollout",
  "student_model": "candidate-model-id",
  "reflection_lm": "frontier-model-id",
  "train_rows": ".understudy/capture-evidence/gepa-train-rollouts.jsonl",
  "dev_rows": ".understudy/capture-evidence/gepa-dev-rollouts.jsonl",
  "metric": ".understudy/capture-evidence/metric.json",
  "exclude_splits": ["holdout"],
  "optimize_target": "system_prompt"
}
```

Do not optimize the entire agent in one opaque string if a cheaper target matches
the failures. Prefer system prompt, tool descriptions, endpoint catalog wording,
or retry policy before broader program changes.

For stateful tool harnesses, the faithful version of GEPA is a live rollout
adapter: each candidate prompt is injected into the harness, train/dev rows are
re-run, and the adapter returns rubric scores plus natural-language failure
feedback. The current public CLI adapters (`eval-input-gepa` and `dspy-gepa`)
optimize flat prompt-to-output rows; use them for decomposed subtasks such as
tool retrieval, or use the live-rollout recipe in
[`../../../docs/agentic-rollout-gepa.md`](../../../docs/agentic-rollout-gepa.md)
when the score must come from real tool execution.

If the harness has no prompt parameter, do not edit benchmark source as an
undocumented side effect. Prefer a checked local patch, prompt file, or env hook
such as `CANDIDATE_SYSTEM_PROMPT`, record it in `harness.json`, save the
candidate prompt or patch as evidence, and restore external benchmark files
before claiming a result. If you own the harness, add `--system-prompt-file` or
an equivalent per-suite override.

## Failure Modes And Cheapest Interventions

| Failure mode | Evidence | First intervention |
| --- | --- | --- |
| Wrong endpoint selected | request log shows plausible but wrong route | compare production tool access vs curated/oracle access, then build or improve tool retrieval |
| Curated tools succeed but production discovery fails | curated/oracle score high, production score low | stateless advisor: task -> compact tool subset, scored by recall/precision vs target tools |
| Missing required write | final-state diff missing expected mutation | prompt repair around completion criteria |
| Forbidden write | request log has disallowed mutation | hard safety instruction plus deterministic preflight guard |
| Invalid request schema | 4xx or validator schema failure | parser/schema repair before model swap |
| Over-calling/retries | high API call count with same final score | endpoint catalog compression and stop condition |
| Policy violation | rubric cites ignored policy doc | policy-doc ordering, shorter policy summary, or stronger model |
| Bad recovery | transient error causes abandoned task | retry policy and error-specific feedback |
| State drift | same row yields different result after reset | fix reset/seed harness before optimizing |

Only escalate to verifier handoff when model A/B and train/dev prompt/tool
optimization stall with real headroom on stateful decisions that cannot be fixed
by clearer instructions, schemas, routing, or retry policy.

## Claim Discipline

Before saying a candidate is better, require `claim.json` with:

- baseline and candidate artifact paths;
- same split, rows, seed, API schema, policy docs, and metric;
- quality delta for both `task_completed_correctly` and `partial_credit`;
- latency and cost basis;
- side-effect safety deltas;
- fallback route or rollback plan;
- caveats and sample size.

Below holdout validation, report an optimization lead, not a win.
