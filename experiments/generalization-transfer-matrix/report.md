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

<!-- GENERATED RECEIPTS START -->
## Run receipts

The following accounting is generated from the checked-in receipts and rows. USD values are estimates, not bills, using the stated price assumptions.

| Model | Calls | Prompt tokens | Completion tokens | Estimated USD | Transport-error rate | Price assumption |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Fireworks gpt-oss-20b | 132 | 67,271 | 20,644 | $0.014985 | 0.0% | $0.10 input / $0.40 output per 1M tokens |
| Anthropic Haiku 4.5 | 189 | 180,871 | 26,905 | $0.315396 | 0.0% | $1 input / $5 output per 1M tokens |

Share of rows with at least one parse failure:

| Model | Group | Rows with parse failure | Total rows | Share |
| --- | --- | ---: | ---: | ---: |
| Fireworks gpt-oss-20b | automationbench-simple-api-offline | 13 | 24 | 54.2% |
| Fireworks gpt-oss-20b | event-categorizer-offline | 7 | 12 | 58.3% |
| Fireworks gpt-oss-20b | synthetic-workflow-shapes-offline | 5 | 9 | 55.6% |
| Anthropic Haiku 4.5 | automationbench-simple-api-offline | 7 | 24 | 29.2% |
| Anthropic Haiku 4.5 | event-categorizer-offline | 2 | 12 | 16.7% |
| Anthropic Haiku 4.5 | synthetic-workflow-shapes-offline | 1 | 9 | 11.1% |

<!-- GENERATED RECEIPTS END -->
