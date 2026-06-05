# Optimize API Workflow — reference

Deep detail for [`SKILL.md`](SKILL.md). AutomationBench evaluates AI agents on
realistic, multi-step business workflows across CRM, email, calendar, and 47
simulated SaaS tools; read this reference when wiring that kind of API workflow
into the Understudy artifact contract, measuring a baseline, and comparing model
or prompt candidates.

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

## Artifact Bridge

Write the standard evidence files under `.understudy/capture-evidence/`. These
examples are intentionally small and synthetic.

### `harness.json` — runnable rollout harness

Record the command that runs one or more full workflow rollouts. `${MODEL}` is
the slot that changes during A/B; the task set, seeded state, API schema, policy
docs, validator, and network boundary stay fixed.

```json
{
  "schema_version": "understudy.harness.v1",
  "kind": "api-workflow-rollout",
  "benchmark": "automationbench",
  "command": "uv run auto-bench --model ${MODEL} --domains ${DOMAINS} --num-examples ${N} --export-json ${EXPORT_JSON}",
  "agent_entrypoint": "auto-bench",
  "policy_model_slot": "${MODEL}",
  "task_source": "automationbench.synthetic",
  "api_schema": {
    "kind": "openapi",
    "path": ".understudy/capture-evidence/api-schema.json"
  },
  "policy_docs": [".understudy/capture-evidence/policy.md"],
  "seeded_state": {
    "reset_command": "uv run auto-bench reset --seed ${SEED}",
    "seed": 7,
    "state_fixture": ".understudy/capture-evidence/seed-state.json"
  },
  "allowed_endpoints": ["GET /records", "POST /records", "PATCH /records/{id}"],
  "request_log": ".understudy/capture-evidence/request-log.jsonl",
  "final_state_validator": {
    "kind": "command",
    "command": "uv run auto-bench validate --export-json ${EXPORT_JSON}"
  },
  "timeout_s": 300,
  "network_boundary": "benchmark-sandbox"
}
```

If `uv run auto-bench` is unavailable in the current repo, do not invent a
replacement command. Record the missing command as a blocker and keep the rest of
the artifact draft local.

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

Map AutomationBench-style `task_completed_correctly` to final-state correctness
and `partial_credit` to the weighted rubric. The rubric must emit natural
language feedback tied to the failing step, endpoint, invariant, or state diff.

```json
{
  "schema_version": "understudy.metric.v1",
  "approved": true,
  "validator": {
    "kind": "api-workflow-rubric",
    "source": "automationbench-export",
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

### `splits.json` — domain/task freeze

AutomationBench domains are useful split units because they expose distribution
shift across workflow families. Keep holdout domains or rows untouched after the
first baseline.

```json
{
  "schema_version": "understudy.splits.v1",
  "source": "automationbench",
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
  "command": "understudy run -- uv run auto-bench --model gpt-5.x --domains finance --num-examples 8 --export-json .understudy/capture-evidence/baseline-export.json",
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

## AutomationBench Command Mapping

Use the benchmark command as the harness instead of inventing a CLI surface:

```sh
uv run auto-bench \
  --model <model-id> \
  --domains sales,marketing \
  --num-examples 8 \
  --export-json .understudy/capture-evidence/<run-name>.json
```

Map flags and export fields into artifacts:

| Command / export field | Artifact field |
| --- | --- |
| `--model <model-id>` | `harness.policy_model_slot`, `baseline.command`, candidate model id |
| `--domains <domains>` | `splits.train.domains`, `splits.dev.domains`, or `splits.holdout.domains` |
| `--num-examples <n>` | `baseline.sample_size`, candidate sample size |
| `--export-json <path>` | `baseline.export_json`, candidate artifact path |
| `task_completed_correctly` | `metric.objectives.quality.primary`, `baseline.quality.task_completed_correctly_rate` |
| `partial_credit` | `metric.objectives.quality.partial_credit`, `baseline.quality.partial_credit_mean` |
| request/tool trace | `harness.request_log`, `baseline.request_log_summary` |
| seeded state/reset metadata | `harness.seeded_state`, `environment.resettable` |

AutomationBench's seeded state is the determinism guarantee. Prefer it over
hand-rolled mocks when available; the agent should record the seed and reset
command, then run every candidate against the same rows and state.

## Workload Card Fill Values

When `capture-evidence` produces a mostly-null workload card, fill the known API
workflow semantics before registering or routing it:

```json
{
  "schema_version": "understudy.workload_card.v1",
  "workload_id": "automationbench-api-workflow",
  "workload_name": "AutomationBench API workflow",
  "workload_shape": ["api-workflow", "multi-step-rollout", "stateful-tools"],
  "data_class": "synthetic-benchmark-state",
  "success_metric": "task_completed_correctly_rate with partial_credit_mean and side-effect safety",
  "validator": {
    "type": "final-state-plus-policy-rubric",
    "artifact": ".understudy/capture-evidence/metric.json"
  },
  "harness": {
    "command": "uv run auto-bench --model ${MODEL} --domains ${DOMAINS} --num-examples ${N} --export-json ${EXPORT_JSON}",
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
benchmark rows twice with only `--model` changed.

```sh
understudy run -- uv run auto-bench \
  --model gpt-5.x \
  --domains sales,marketing \
  --num-examples 8 \
  --export-json .understudy/capture-evidence/baseline-gpt5x.json

understudy run -- uv run auto-bench \
  --model glm-5.1 \
  --domains sales,marketing \
  --num-examples 8 \
  --export-json .understudy/capture-evidence/candidate-glm51.json
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
  "student_model": "glm-5.1",
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

## Failure Modes And Cheapest Interventions

| Failure mode | Evidence | First intervention |
| --- | --- | --- |
| Wrong endpoint selected | request log shows plausible but wrong route | tighten tool descriptions and endpoint catalog examples |
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
