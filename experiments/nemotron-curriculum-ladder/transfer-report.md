# Generalization report

- Frozen split: `sealed-holdout-not-read`
- In-domain gain: null
- Transfer gain: 0.0060
- Transfer ratio: null
- Forgetting: -0.0028
- Generalization score: null

## Transfer matrix

- sft score: null
- grpo score: null
- dpo score: null

| Arm | AutomationBench Simple API | Event Categorizer | Synthetic Workflow Shapes |
| --- | --- | --- | --- |
| sft | ◆ planned | +0.000 (n=10) | +0.025 (n=60) |
| grpo | ◆ planned | +0.000 (n=10) | -0.001 (n=60) |
| dpo | ◆ planned | +0.000 (n=10) | -0.003 (n=60) |

◆ = in-domain training group; numeric cells show delta and paired task count.

## Coverage

| Group | Status | Tasks |
| --- | --- | --- |
| AutomationBench Simple API | planned | 0 |
| Event Categorizer | scored | 10 |
| Synthetic Workflow Shapes | scored | 60 |
