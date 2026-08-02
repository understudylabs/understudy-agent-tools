# Nemotron SFT → DPO comparison arm

This isolated experiment compares a DPO marginal lift against PR #402's
SFT → GRPO arm on the same Nemotron base model and offline evaluator fixture.
The rollout, renderer, parser, environment client, evaluator, and receipt
implementation are imported from `experiments/nemotron-tinker-grpo/` rather
than copied, so the evaluation protocol remains byte-identical.

## Protocol

- Base: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`
- Renderer: `nemotron3_disable_thinking`
- LoRA rank: 32. The original brief said 16, but #402's actual recipe and
  checkpoints are rank 32; this arm follows the real recipe.
- Warm start: exact #402 state
  `tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/weights/sft-epoch4-state`
- Reference policy: exact #402 SFT sampler
  `tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/sampler_weights/sft-epoch4`
- DPO defaults: beta `0.1`, learning rate `1e-5`, three epochs, assistant-only
  token weights, and token-sum sequence reduction.
- Training data and pair construction are train-only. Every pair builder input
  is hard-guarded to `split == "train"`.
- Selection is dev-only: maximize mean reward, tie-break toward the earliest
  checkpoint, matching #402's GRPO rule.
- Holdout is read exactly once, at the end, for the selected DPO checkpoint,
  with the frozen holdout SHA256 explicitly supplied.
- This box uses a TLS-inspecting proxy that breaks Tinker's default pyqwest
  transport. To opt into the HTTP transport workaround explicitly, set
  `TINKER_DISABLE_PYQWEST=1`; the shared helper honors this flag and is not
  automatic.

The apples-to-apples rationale is important: loading the exact #402 SFT state
means DPO and GRPO are both marginal-lift tests from identical warm-start
weights, rather than comparisons of two independently reproduced SFT runs.

## Commands

```bash
npm run build
node scripts/automationbench-sanity-gate.mjs \
  --out experiments/nemotron-tinker-dpo/artifacts/sanity-gate.json
TINKER_API_KEY=... /home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-dpo/build_pairs.py
TINKER_API_KEY=... /home/ubuntu/tinker-venv/bin/python \
  experiments/nemotron-tinker-dpo/dpo.py
```

The API key is supplied only through the exec environment and is never written
to logs or artifacts.

## Results

The selected checkpoint is DPO epoch 2:

```text
tinker://4cd4a253-74e7-5d42-ba70-b081baffbbb1:train:0/sampler_weights/dpo-epoch2
```

Selection used dev mean reward, with earliest-epoch tie-breaking. The full
comparison is:

| Arm | Train | Dev | Holdout |
|---|---:|---:|---:|
| Base | 0.896 | 0.861 | 0.944 |
| SFT | 0.955 | 0.944 | 0.944 |
| SFT + GRPO | 0.979 | 1.000 | 1.000 |
| SFT + DPO | 0.979 | 1.000 | 1.000 |

Per-band means (`single-write / discovery / multi-write`) are:

| Arm | Train | Dev | Holdout |
|---|---|---|---|
| Base | 1.000 / 0.938 / 0.750 | 1.000 / 0.750 / 0.833 | 1.000 / 1.000 / 0.833 |
| SFT | 1.000 / 1.000 / 0.865 | 1.000 / 1.000 / 0.833 | 1.000 / 1.000 / 0.833 |
| SFT + GRPO | 1.000 / 1.000 / 0.938 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |
| SFT + DPO | 1.000 / 1.000 / 0.938 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |

The DPO marginal lift over SFT is `+0.024` on train, `+0.056` on dev, and
`+0.056` on holdout. The cited #402 GRPO marginal lift over SFT is `+0.024`
on train, `+0.056` on dev, and `+0.056` on holdout. On this 12-task dev and
holdout fixture, DPO matches the selected GRPO arm exactly, including the
multi-write band.

The sealed #402 rows used for comparison came from these artifacts:

| Arm | Train | Dev | Holdout |
|---|---:|---:|---:|
| Base | `baseline-train.summary.json` 0.896 | `baseline-dev.summary.json` 0.861 | `holdout-base.summary.json` 0.944 |
| SFT | `sft-selected-train.summary.json` 0.955 | `sft-selected-dev.summary.json` 0.944 | `holdout-sft-epoch4.summary.json` 0.944 |
| SFT + GRPO | `grpo-selected-step20-train.summary.json` 0.979 | `grpo-step20-dev.summary.json` 1.000 | `holdout-grpo-step20.summary.json` 1.000 |

# Verdict

This fixture produces a **tie at the ceiling**. DPO and GRPO both add
`+0.056` over SFT on dev and holdout, with the gain concentrated in
multi-write; single-write and discovery were already `1.000` after SFT.
Neither arm can be separated by a 12-task holdout that both saturate. A harder
or larger fixture is needed to distinguish them.

The cost separator favors the simpler DPO loop in this run. DPO's main-run
evaluator total was `774,050` tokens (`731,999` prompt plus `42,051` sampled)
across pair sampling and train/dev/holdout evaluation. The required post-run
three-task smoke evaluation added `3,783` tokens, for `777,833` measured
evaluator tokens overall. The DPO training-client responses and metrics expose
no training-token counter, so training tokens could not be added; this is
stated in `artifacts/token-receipt.json` rather than estimated. #402 reported
approximately `5,349,611` tokens:

| #402 phase | Tokens |
|---|---:|
| Baseline handoff | 426,680 |
| SFT | 356,662 |
| GRPO Stage 1 | 213,219 |
| GRPO Stage 2 | 4,280,921 |
| Sealed holdout | 72,129 |
| **Total** | **5,349,611** |

DPO required one sampling pass for pair construction plus 24 optimizer steps;
GRPO used a multi-stage online rollout/training loop.

## SFT train-cell noise

#402 contains two greedy train evaluations of the same epoch-4 SFT checkpoint:
`sft-epoch4-train.summary.json` reports `0.976`, while
`sft-selected-train.summary.json` reports `0.955`. This README uses the latter
for consistency with #402's selected-arm comparison artifact. The approximately
`0.02` run-to-run variation on a temperature-0 re-evaluation of an identical
checkpoint is the same order as the marginal lifts being compared, so train
lift differences should not be overinterpreted.

## Failure modes and honest findings

- 17 of 48 train tasks were degenerate at temperature 1.0, with no reward
  variance. Preference data is scarce when SFT is near ceiling.
- The DPO margin grew mainly by pushing rejected logprobs down while chosen
  logprobs slightly decreased: epoch 1 batch 1 had chosen reward
  `-0.0000223`, rejected reward `+0.012429`, margin `-0.012451`; epoch 3 batch
  8 had chosen reward `-0.003777`, rejected reward `-0.525075`, margin
  `+0.521298`. This is a likelihood-displacement pattern, not unambiguous
  chosen-likelihood improvement.
- DPO is epoch-sensitive: epoch 3 regressed to `0.917` dev mean reward, with
  multi-write at `0.750`. The result therefore depends on dev selection of
  epoch 2.
- Greedy parse-error rates were `0.083` on dev, `0.042` on train, and `0.0` on
  holdout.

The fixture has 12 dev and 12 holdout tasks, so approximately one task is
`0.083` reward. The fixture is synthetic and offline, not upstream
AutomationBench. The base model already scores near ceiling, and SFT may yield
few non-degenerate preference pairs.

## Artifacts and caveats

- `sanity-gate.json`: scripted oracle/sentinel gate and fixture hashes.
- `dpo-pairs.jsonl` and `dpo-pairs.summary.json`: evaluator-scored real rollout
  comparisons, with reward gaps and band/source counts.
- `dpo-training-metrics.json`: per-step DPO loss, margin, implicit accuracy,
  and checkpoint paths.
- `dpo-selection.json`: dev-only selection record, written before holdout access.
- `*-summary.json`, `*-usage.json`, and receipts: evaluator metrics and usage.
- `cleanup-report.json`: created checkpoint expiry and cleanup status.

Raw rollout JSONL files are committed where they provide provenance for the
preference pairs, including `dpo-rollouts-sft.jsonl`; generated evaluation
JSONL files remain ignored when they are not needed as committed artifacts.
