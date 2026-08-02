# Nemotron transfer report (dev, holdout)

- In-domain gain: 0.08333333333333333
- Transfer gain: 0.0625
- Transfer ratio: 0.75
- Forgetting: 0
- Forgetting penalty: 0
- Regressed groups: none
- Forgetting-penalized generalization score: 0.75

## Transfer matrix

| Group | In domain | Tasks | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| automationbench-simple-api | yes | 24 | 0.9166666666666666 | 1 | 0.08333333333333333 | 2 | 0 | 22 | scored |
| event-categorizer | no | 4 | 1 | 1 | 0 | 0 | 0 | 4 | scored |
| synthetic-workflow-shapes | no | 4 | 0 | 0.125 | 0.125 | 1 | 0 | 3 | scored |

## Per-task deltas

### automationbench-simple-api

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| simple-api-crm-bulk-owner-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-bulk-owner-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-06 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-05 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-06 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-06 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-06 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-06 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-05 | 0 | 1 | 1 | fixed |
| simple-api-mail-send-06 | 0 | 1 | 1 | fixed |
| simple-api-mail-send-and-close-05 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-and-close-06 | 1 | 1 | 0 | unchanged |

### event-categorizer

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| evt-009 | 1 | 1 | 0 | unchanged |
| evt-010 | 1 | 1 | 0 | unchanged |
| evt-011 | 1 | 1 | 0 | unchanged |
| evt-012 | 1 | 1 | 0 | unchanged |

### synthetic-workflow-shapes

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| saw-analysis-001 | 0 | 0 | 0 | unchanged |
| saw-analysis-002 | 0 | 0 | 0 | unchanged |
| saw-doc-001 | 0 | 0.5 | 0.5 | fixed |
| saw-doc-002 | 0 | 0 | 0 | unchanged |

## Coverage

```json
{
  "groups": [
    {
      "group_id": "automationbench-simple-api",
      "label": "AutomationBench simple/api",
      "status": "scored",
      "task_count": 24
    },
    {
      "group_id": "event-categorizer",
      "label": "Event Categorizer verifiers",
      "status": "scored",
      "task_count": 4
    },
    {
      "group_id": "synthetic-workflow-shapes",
      "label": "Synthetic workflow shapes",
      "status": "scored",
      "task_count": 4
    }
  ],
  "unassigned_task_ids": []
}
```
