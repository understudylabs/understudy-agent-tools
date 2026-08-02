# Nemotron adapter portfolio

Phase 1 evidence for one Nemotron base model with task-specific Tinker LoRA
adapters on the synthetic AutomationBench offline evaluator.

- Base: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- Fixture: 48 train / 12 dev / 12 holdout, seed 7
- Bands: single-write, discovery, multi-write
- Runtime worktree: `/home/ubuntu/repos/grpo-arm`
- Runtime branch: `origin/devin/nemotron-tinker-grpo-arm`

The runtime worktree is intentionally not merged into this branch. All
committed evidence and the Adapter B harness live under this directory.

## Adapter A: retained GRPO multi-write adapter

The retained stage-2 step-20 sampler loaded successfully and passed a
three-task dev smoke evaluation. Its path and expiry metadata are in
`artifacts/adapter-a/checkpoint-verification.json`. The complete base-vs-GRPO
scorecard, including the sealed prior-art holdout, is in
`artifacts/adapter-a/scorecard.json`; no Adapter A holdout was rerun.

## Adapter B: single-write SFT adapter

The harness in `scripts/train_adapter_b.py` filters oracle data to exactly the
16 `split=train`, `band=single-write` rows, trains rank-8 LoRA for four epochs,
and selects only on the four-task dev single-write band. Epochs 1–4 tied at
dev mean reward 1.0, so epoch 1 was selected by the earliest-tie rule.

The selection record was committed before holdout access. The base and
selected adapter were each evaluated exactly once on the four-task
single-write holdout with fixture hash
`0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f` and
holdout hash
`a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701`.
The seal is recorded in `artifacts/adapter-b/holdout-seal.json`.

## Usage

Tinker billing snapshots returned empty event data during this run. The
phase receipt therefore records provider-equivalent evaluator tokens
(prompt + sampled) and training model-input tokens, with the empty billing
response preserved in each `.usage.json` receipt. No API key is written to
the repository.
