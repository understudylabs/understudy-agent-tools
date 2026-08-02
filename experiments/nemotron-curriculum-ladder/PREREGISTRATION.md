# Nemotron Curriculum Ladder v2 Holdout Preregistration

This file fixes the holdout sweep before any holdout task is read. Each listed
cell will be evaluated exactly once. No holdout result may be used for prompt,
checkpoint, parser, renderer, step-limit, or cell selection, and no cell will
be rerun after a mid-run error without a new explicit decision and a new
preregistration.

## Frozen evaluation contract

- Benchmark: `automationbench-v2`
- Split: `holdout`
- Fixture holdout SHA-256:
  `2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9`
- Renderer: `nemotron3_disable_thinking`
- Temperature: `0.0`
- Samples per task: `1`
- Tasks: all 60 tasks in the sealed v2 holdout split
- Model-turn / step limit: `12`
- Parser: uniform tolerant parser for every cell:
  bare JSON, `<tool_call>...</tool_call>`, canonical JSON finish, and
  `<finish/>` mapped to the terminal action
- Prompt composition: system prompt plus task user message plus the
  observation-provided `Available tools` catalog, uniformly for every cell
- Scoring: offline final-state/outcome-first evaluator, unchanged fixture,
  assertions, partial-credit logic, and forbidden-effect checks
- Lane: Tinker only

## Exactly-once cell list

| Cell | Model path | Prompt |
| --- | --- | --- |
| base + `nemotron-v1` | `base` | service `nemotron-v1` prompt |
| base + GEPA v3 | `base` | `artifacts/gepa-v3-prompt.txt` |
| SFT epoch 4 + `nemotron-v1` | `tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/sampler_weights/sft-epoch4` | service `nemotron-v1` prompt |
| SFT epoch 4 + GEPA v3 | `tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/sampler_weights/sft-epoch4` | `artifacts/gepa-v3-prompt.txt` |
| GRPO step 20 + `nemotron-v1` | `tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020` | service `nemotron-v1` prompt |
| GRPO step 20 + GEPA v3 | `tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020` | `artifacts/gepa-v3-prompt.txt` |
| DPO epoch 2 + `nemotron-v1` | `tinker://4cd4a253-74e7-5d42-ba70-b081baffbbb1:train:0/sampler_weights/dpo-epoch2` | service `nemotron-v1` prompt |
| DPO epoch 2 + GEPA v3 | `tinker://4cd4a253-74e7-5d42-ba70-b081baffbbb1:train:0/sampler_weights/dpo-epoch2` | `artifacts/gepa-v3-prompt.txt` |

The GEPA prompt SHA-256 is:

```text
cd40fea74a04902a3a96ddc4856a4480ff19d243396d414a4a59409c2f407727
```

The holdout sweep is a fixed 2x4 grid, not a selection procedure. Dev
selection and the prompt-carry analysis are complete before this sweep.
