# Nemotron transfer matrix

This experiment asks whether the multi-write improvement from PR #402 transfers
beyond AutomationBench:

1. Does the retained SFT + GRPO step-20 arm transfer to the event-categorizer
   and synthetic-workflow-shapes groups?
2. Is there forgetting or negative transfer outside the AutomationBench
   training group?

## Method and provenance

Both arms used the same localhost Tinker sampling shim, renderer, prompt
protocol, greedy sampling parameters, and 12-turn limit. The arms were:

| Arm | Model |
|---|---|
| Base | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| Tuned | `tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020` |

The recorded `/health` identity for the tuned arm was:

```json
{
  "model_path": "tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020",
  "renderer": "nemotron3_disable_thinking",
  "lora_rank": 32,
  "checkpoint_base_model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
}
```

The base `/health` identity used the same base model and renderer with no
checkpoint or LoRA rank. Every run summary and receipt contains the complete
verbatim health snapshot.

Sampling was greedy (`temperature: 0`), with `max_tokens: 192` and at most 12
model turns. Prompt and completion token counts were recorded per sample.
Tinker exposes no USD accounting in the installed SDK, so dollar values below
are explicitly labeled estimates using `$1/M` input and `$4/M` output tokens.

### Groups and splits

| Group | Train | Dev | Holdout | Frozen holdout hash |
|---|---:|---:|---:|---|
| `automationbench-simple-api` | 48 | 12 | 12 | `a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701` |
| `event-categorizer` | 8 | 2 | 2 | `803ed4bf0664783d76b9e8b7aa139a15a9ff5a82cda402f214d8225ce02dcee2` |
| `synthetic-workflow-shapes` | 5 | 2 | 2 | `01cec7ca0034b6a803070e9fc83e62be1ccac6da77df5bb6d29e4ec25d711326` |

The pre-model sanity gate passed before every phase:

- Group A single-write and multi-write: oracle `1.0`, sentinel `0.0`
- Group C single-write and multi-write: oracle `1.0`, sentinel `0.0`
- Group B variant: gold completion `1.0`, empty completion `0.0`

Prompt parity is checked with
`scripts/generalization-prompt-parity.mjs`. Each arm writes independent
per-task system+user hashes, and the checker compares base against tuned for
each group/split. Prompts are byte-identical **across arms within a group**;
they are necessarily not identical across groups because the task surfaces
differ. Group A's system prompt is byte-identical to the training-time
`ACTION_PROTOCOL_SYSTEM_PROMPT`. The holdout checker passed for all six
holdout arm/group runs.

The checkpoint was retained and selected before this transfer experiment in
PR #402 based on its existing dev selection. No holdout result was used for
checkpoint, prompt, protocol, or scoring choices. This statement is recorded
in `artifacts/holdout-selection-statement.json`.

## Per-arm results

Strict pass is the fraction of rows with score exactly `1.0`. Wall clock is
the evaluator wall clock for that arm/group/split.

### Train

| Arm | Group | Mean | Strict pass | Parse failures | Error rate | Tokens | Wall clock (s) | Est. USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Base | AutomationBench | 0.9201 | 89.58% | 0 | 0% | 151,547 | 1040.5 | 0.180155 |
| Tuned | AutomationBench | 1.0000 | 100.00% | 0 | 0% | 69,256 | 363.7 | 0.080107 |
| Base | Event Categorizer | 0.9625 | 87.50% | 0 | 0% | 4,838 | 20.6 | 0.005567 |
| Tuned | Event Categorizer | 0.9625 | 87.50% | 0 | 0% | 4,835 | 22.0 | 0.005555 |
| Base | Synthetic Workflow | 0.2000 | 20.00% | 0 | 0% | 15,665 | 71.7 | 0.018854 |
| Tuned | Synthetic Workflow | 0.2667 | 20.00% | 1 | 0% | 7,807 | 37.4 | 0.009472 |

### Dev

| Arm | Group | Mean | Strict pass | Parse failures | Error rate | Tokens | Wall clock (s) | Est. USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Base | AutomationBench | 0.9167 | 91.67% | 0 | 0% | 35,764 | 123.4 | 0.042421 |
| Tuned | AutomationBench | 1.0000 | 100.00% | 0 | 0% | 17,510 | 111.0 | 0.020222 |
| Base | Event Categorizer | 1.0000 | 100.00% | 0 | 0% | 1,220 | 6.9 | 0.001415 |
| Tuned | Event Categorizer | 1.0000 | 100.00% | 0 | 0% | 1,223 | 5.0 | 0.001427 |
| Base | Synthetic Workflow | 0.0000 | 0.00% | 0 | 0% | 12,646 | 67.8 | 0.014689 |
| Tuned | Synthetic Workflow | 0.2500 | 0.00% | 1 | 0% | 12,032 | 65.5 | 0.013718 |

### Sealed holdout

| Arm | Group | Mean | Strict pass | Parse failures | Error rate | Tokens | Wall clock (s) | Est. USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Base | AutomationBench | 0.9167 | 91.67% | 0 | 0% | 39,475 | 144.3 | 0.046927 |
| Tuned | AutomationBench | 1.0000 | 100.00% | 0 | 0% | 17,162 | 119.6 | 0.019853 |
| Base | Event Categorizer | 1.0000 | 100.00% | 0 | 0% | 1,200 | 17.0 | 0.001377 |
| Tuned | Event Categorizer | 1.0000 | 100.00% | 0 | 0% | 1,200 | 28.0 | 0.001377 |
| Base | Synthetic Workflow | 0.0000 | 0.00% | 0 | 0% | 12,655 | 44.2 | 0.014767 |
| Tuned | Synthetic Workflow | 0.0000 | 0.00% | 0 | 0% | 7,086 | 45.1 | 0.008199 |

## Transfer matrices

Each matrix compares base to tuned for the selected split(s). The in-domain
group is AutomationBench; the other two groups are transfer groups.

### Train

| Group | In domain | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged |
|---|---:|---:|---:|---:|---:|---:|---:|
| AutomationBench | yes | 0.9201 | 1.0000 | +0.0799 | 5 | 0 | 43 |
| Event Categorizer | no | 0.9625 | 0.9625 | 0.0000 | 1 | 1 | 6 |
| Synthetic Workflow | no | 0.2000 | 0.2667 | +0.0667 | 1 | 0 | 4 |

`in_domain_gain=0.079861`, `transfer_gain=0.025641`,
`transfer_ratio=0.321070`, `forgetting=0`, `regressed_groups=[]`,
`generalization_score=0.321070`.

### Dev

| Group | In domain | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged |
|---|---:|---:|---:|---:|---:|---:|---:|
| AutomationBench | yes | 0.9167 | 1.0000 | +0.0833 | 1 | 0 | 11 |
| Event Categorizer | no | 1.0000 | 1.0000 | 0.0000 | 0 | 0 | 2 |
| Synthetic Workflow | no | 0.0000 | 0.2500 | +0.2500 | 1 | 0 | 1 |

`in_domain_gain=0.083333`, `transfer_gain=0.125000`,
`transfer_ratio=1.500000`, `forgetting=0`, `regressed_groups=[]`,
`generalization_score=1`.

### Sealed holdout

| Group | In domain | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged |
|---|---:|---:|---:|---:|---:|---:|---:|
| AutomationBench | yes | 0.9167 | 1.0000 | +0.0833 | 1 | 0 | 11 |
| Event Categorizer | no | 1.0000 | 1.0000 | 0.0000 | 0 | 0 | 2 |
| Synthetic Workflow | no | 0.0000 | 0.0000 | 0.0000 | 0 | 0 | 2 |

`in_domain_gain=0.083333`, `transfer_gain=0`,
`transfer_ratio=0`, `forgetting=0`, `regressed_groups=[]`,
`generalization_score=0`.

### Combined dev + holdout

| Group | In domain | Base mean | Tuned mean | Delta | Fixed | Regressed | Unchanged |
|---|---:|---:|---:|---:|---:|---:|---:|
| AutomationBench | yes | 0.9167 | 1.0000 | +0.0833 | 2 | 0 | 22 |
| Event Categorizer | no | 1.0000 | 1.0000 | 0.0000 | 0 | 0 | 4 |
| Synthetic Workflow | no | 0.0000 | 0.1250 | +0.1250 | 1 | 0 | 3 |

`in_domain_gain=0.083333`, `transfer_gain=0.062500`,
`transfer_ratio=0.750000`, `forgetting=0`, `regressed_groups=[]`,
`generalization_score=0.75`.

The machine-readable versions are under `artifacts/reports/`.

## Failure modes and interpretation

- Group C remains difficult. Transcripts show valid calls followed by looping
  on long compound tasks rather than a harness failure.
- The one Group B train task that regressed is offset by one fixed task, leaving
  its aggregate train delta at zero.
- The tuned arm had one parse-failure row in Group C train and one in Group C
  dev. There were no tuned holdout parse failures.
- Holdout shows positive in-domain transfer, no measurable Event Categorizer
  transfer, and no Synthetic Workflow transfer.
- No group has a negative tuned-minus-base mean delta in these reports, but
  zero deltas on ceiling groups and strict-pass floors are weak evidence.

## Caveats

1. Dev and holdout are tiny: A has 12 tasks, B has 2, and C has 2. One task
   changes a B/C group mean by 0.5, and changes A by approximately 0.0833.
2. Event Categorizer is at the ceiling on dev and holdout for both arms.
3. Synthetic Workflow strict pass is at the floor on dev and holdout for both
   arms, even where partial credit differs.
4. Groups B and C use synthetic offline fixtures, not upstream AutomationBench.
5. USD values are estimated from token counts, not provider-reported billing.
6. The transfer ratio and generalization score are task-weighted summaries
   over these small splits; they should not be treated as population estimates.

## Receipts and cleanup

| Phase | Tokens | Estimated USD | Evaluator wall clock |
|---|---:|---:|---:|
| Train | 253,948 | 0.299710 | 1,556.0 s |
| Dev | 80,395 | 0.093892 | 379.5 s |
| Holdout | 78,778 | 0.092500 | 398.2 s |
| Total | 413,121 | 0.486102 | 2,333.7 s |

Each run has rows, receipts, transcripts, a summary, and a sampler health
snapshot under `artifacts/`. The two local shims were stopped after the
matrix completed. No Tinker serving or deployment resource was created;
sampling clients and the two local HTTP servers were ephemeral. No
billable Tinker resource was created or deleted by this experiment beyond
sampling requests. The #402 checkpoints remain retained as evidence.

`artifacts/cleanup-report.json` records the final process, port, resource, and
checkpoint confirmation.
