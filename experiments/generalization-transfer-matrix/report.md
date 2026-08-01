# Generalization report

- Frozen split: `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`
- In-domain gain: 1.0000
- Transfer gain: 0.0294
- Transfer ratio: 0.0294
- Forgetting: 0.0000
- Generalization score: 0.0294

## Transfer matrix

| Arm | AutomationBench simple/api | Event Categorizer verifiers | Synthetic workflow shapes |
| --- | --- | --- | --- |
| zeroshot-haiku-vs-gptoss | +0.000 (n=14) | +0.083 (n=12) | +0.000 (n=8) |
| mechanism-demo | ◆ +1.000 (n=72) | ◆ +1.000 (n=12) | ◆ +1.000 (n=9) |

◆ = in-domain training group; numeric cells show delta and paired task count.

## Coverage

| Group | Status | Tasks |
| --- | --- | --- |
| AutomationBench simple/api | scored | 72 |
| Event Categorizer verifiers | scored | 12 |
| Synthetic workflow shapes | scored | 9 |
