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

Important interpretation: the single-write target band was already saturated
by the base model: base scored 1.0 on the single-write train, dev, and holdout
rows. Adapter B therefore demonstrates the SFT method, a retained serving
artifact, and the train-only data guard; it does not demonstrate a quality
lift.

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

## Adapter C: weightless discovery prompt variant

Adapter C is a prompt-only adapter over the same base model. Three
deterministic mutations plus the default prompt were scored on the discovery
train and dev bands. All candidates tied at dev mean reward 1.0; the
`search-first` mutation was selected by the declared candidate-order
tie-break. On the sealed discovery holdout, both the default and selected
prompt scored mean reward 0.75, so the prompt variant did not lift quality.
The frozen selection and holdout records are under
`artifacts/adapter-c/selection.json` and `artifacts/adapter-c/holdout-seal.json`.

The frozen fixture exposes 16 discovery train tasks (not 12 as stated in the
brief), 4 discovery dev tasks, and 4 discovery holdout tasks; all 16 train
tasks were used.

The prior-art `baseline-dev.summary.json` recorded discovery mean 0.75, while
this fresh base-default prompt run recorded 1.0 on the same four dev tasks.
The discrepancy is preserved rather than normalized away; it indicates
sampling/runtime variance in repeated hosted base evaluations and is another
reason not to claim a prompt lift from this small band.

## Tinker multi-adapter serving proof

`scripts/multi_adapter_serving_demo.py` creates one Tinker `ServiceClient`
against the single Nemotron base, then keeps base, Adapter A, and Adapter B
sampling clients open concurrently. It interleaves three rounds of Adapter A
on multi-write tasks and Adapter B on single-write tasks without teardown
between swaps. All six requests scored strictly correct. Timings and paths
are in `artifacts/multi-adapter-tinker/serving-demo.json`.

## Other serving lane status

The Fireworks-Nemotron multi-LoRA probe is confirmed negative and was not
modified or deployed: `base+addon supportsLora=False`, `--enable-addons` was
rejected, and grouped shape creation returned `PermissionDenied`. Self-host
multi-adapter proof is deferred to a separate Modal/vLLM arm.
