# Generalization report

- Frozen split: `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`
- In-domain gain: null
- Transfer gain: 0.3170
- Transfer ratio: null
- Forgetting: 0.1481
- Generalization score: null

## Transfer matrix

- zeroshot-haiku-vs-gptoss score: null
- mechanism-demo score (excluded): 0.0000

| Arm | AutomationBench simple/api | Event Categorizer verifiers | Synthetic workflow shapes |
| --- | --- | --- | --- |
| zeroshot-haiku-vs-gptoss | +0.410 (n=24) | +0.258 (n=12) | +0.148 (n=9) |
| mechanism-demo | ◆ +1.000 (n=72) | -0.400 (n=12) | -0.074 (n=9) |

◆ = in-domain training group; numeric cells show delta and paired task count.

## Coverage

| Group | Status | Tasks |
| --- | --- | --- |
| AutomationBench simple/api | scored | 72 |
| Event Categorizer verifiers | scored | 12 |
| Synthetic workflow shapes | scored | 9 |
