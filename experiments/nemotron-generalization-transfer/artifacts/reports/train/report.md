# Nemotron transfer report (train)

- In-domain gain: 0.07986111111111112
- Transfer gain: 0.02564102564102564
- Transfer ratio: 0.3210702341137123
- Forgetting: 0
- Forgetting penalty: 0
- Regressed groups: none
- Forgetting-penalized generalization score: 0.3210702341137123

## Transfer matrix

| Group | In domain | Tasks | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| automationbench-simple-api | yes | 48 | 0.920138888888889 | 1 | 0.07986111111111112 | 5 | 0 | 43 | scored |
| event-categorizer | no | 8 | 0.9625 | 0.9625 | 0 | 1 | 1 | 6 | scored |
| synthetic-workflow-shapes | no | 5 | 0.2 | 0.26666666666666666 | 0.06666666666666667 | 1 | 0 | 4 | scored |

## Per-task deltas

### automationbench-simple-api

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| simple-api-crm-bulk-owner-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-bulk-owner-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-bulk-owner-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-bulk-owner-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-close-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-disambiguate-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-lost-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-01 | 0.5 | 1 | 0.5 | fixed |
| simple-api-crm-mail-churn-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-mail-churn-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-owner-04 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-01 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-02 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-03 | 1 | 1 | 0 | unchanged |
| simple-api-crm-rename-04 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-01 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-02 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-03 | 1 | 1 | 0 | unchanged |
| simple-api-mail-discard-04 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-01 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-02 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-03 | 1 | 1 | 0 | unchanged |
| simple-api-mail-draft-04 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-01 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-02 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-03 | 1 | 1 | 0 | unchanged |
| simple-api-mail-revise-04 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-01 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-02 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-03 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-04 | 0 | 1 | 1 | fixed |
| simple-api-mail-send-and-close-01 | 1 | 1 | 0 | unchanged |
| simple-api-mail-send-and-close-02 | 0.3333333333333333 | 1 | 0.6666666666666667 | fixed |
| simple-api-mail-send-and-close-03 | 0.3333333333333333 | 1 | 0.6666666666666667 | fixed |
| simple-api-mail-send-and-close-04 | 0 | 1 | 1 | fixed |

### event-categorizer

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| evt-001 | 1 | 1 | 0 | unchanged |
| evt-002 | 1 | 1 | 0 | unchanged |
| evt-003 | 1 | 1 | 0 | unchanged |
| evt-004 | 0.7 | 1 | 0.30000000000000004 | fixed |
| evt-005 | 1 | 1 | 0 | unchanged |
| evt-006 | 1 | 1 | 0 | unchanged |
| evt-007 | 1 | 1 | 0 | unchanged |
| evt-008 | 1 | 0.7 | -0.30000000000000004 | regressed |

### synthetic-workflow-shapes

| Task | Base | Tuned | Delta | Outcome |
|---|---:|---:|---:|---|
| saw-email-001 | 0 | 0 | 0 | unchanged |
| saw-email-002 | 0 | 0 | 0 | unchanged |
| saw-meeting-001 | 0 | 0 | 0 | unchanged |
| saw-orch-001 | 0 | 0.3333333333333333 | 0.3333333333333333 | fixed |
| saw-record-001 | 1 | 1 | 0 | unchanged |

## Coverage

```json
{
  "groups": [
    {
      "group_id": "automationbench-simple-api",
      "label": "AutomationBench simple/api",
      "status": "scored",
      "task_count": 48
    },
    {
      "group_id": "event-categorizer",
      "label": "Event Categorizer verifiers",
      "status": "scored",
      "task_count": 8
    },
    {
      "group_id": "synthetic-workflow-shapes",
      "label": "Synthetic workflow shapes",
      "status": "scored",
      "task_count": 5
    }
  ],
  "unassigned_task_ids": []
}
```
