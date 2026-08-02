# Nemotron transfer report (dev)

- In-domain gain: 0.08333333333333333
- Transfer gain: 0.125
- Transfer ratio: 1.5
- Forgetting: 0
- Forgetting penalty: 0
- Regressed groups: none
- Forgetting-penalized generalization score: 1

## Transfer matrix

| Group | In domain | Tasks | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| automationbench-simple-api | yes | 12 | 0.9166666666666666 | 1 | 0.08333333333333333 | 1 | 0 | 11 | scored |
| event-categorizer | no | 2 | 1 | 1 | 0 | 0 | 0 | 2 | scored |
| synthetic-workflow-shapes | no | 2 | 0 | 0.25 | 0.25 | 1 | 0 | 1 | scored |

## Per-task deltas

### automationbench-simple-api

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| simple-api-crm-bulk-owner-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-05 | 0 | 1 | 1 | fixed |
| simple-api-mail-send-and-close-05 | 1 | 1 | 0 | unchanged |

### event-categorizer

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| evt-009 | 1 | 1 | 0 | unchanged |
| evt-010 | 1 | 1 | 0 | unchanged |

### synthetic-workflow-shapes

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| saw-analysis-001 | 0 | 0 | 0 | unchanged |
| saw-doc-001 | 0 | 0.5 | 0.5 | fixed |

## Coverage

```json
{
  "groups": [
    {
      "group_id": "automationbench-simple-api",
      "label": "AutomationBench simple/api",
      "status": "scored",
      "task_count": 12
    },
    {
      "group_id": "event-categorizer",
      "label": "Event Categorizer verifiers",
      "status": "scored",
      "task_count": 2
    },
    {
      "group_id": "synthetic-workflow-shapes",
      "label": "Synthetic workflow shapes",
      "status": "scored",
      "task_count": 2
    }
  ],
  "unassigned_task_ids": []
}
```
