---
name: calibrate-difficulty
description: Use before investing in a training arm to measure per-band headroom and block bands where the incumbent is saturated.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Calibrate Difficulty

Run this skill before committing training effort to a benchmark band. It reads
an existing per-task run artifact locally, groups rows by difficulty band, and
reports whether each band has enough measured headroom to justify investment.
It does not sample a model, alter a benchmark, or access a sealed split.

## Safety Gates

- Use an existing incumbent run artifact; do not treat a missing or malformed
  score as a failure score.
- Keep the benchmark fixture, model, split, and row protocol visible in the
  report. Do not combine rows from different fixtures or splits.
- A band with incumbent mean score at or above `0.95` is saturated and is not
  an investable training target.
- A band with fewer than 10 scored rows is directional by default. Use
  `--min-sample` only when the smaller decision rule is intentional.
- Do not use a holdout run to choose a training investment. The v2 dev split
  has only roughly 2–6 tasks per band, so a real gate should use the train
  split or a larger frozen evaluation.

## Command

Build the repository, then run:

```bash
npm run build
node scripts/difficulty-calibration.mjs \
  --run outputs/zeroshot-qwen3p7-plus-dev.json \
  --fixture auto \
  --out outputs/difficulty-calibration/qwen3p7-plus-dev.json
```

Options:

- `--fixture auto|v1|v2`
- `--threshold 0.95`
- `--min-sample 10`
- `--out <path>`

## Reading the report

Each band has `mean_score`, `headroom`, a simple 95% confidence interval,
sample counts, and a status:

- `saturated` / `block_training`: mean score meets the saturation threshold;
  this surface cannot measure a training lift reliably.
- `measurable` / `invest`: the band has enough scored rows and mean score below
  the threshold; its remaining headroom is a candidate training target.
- `insufficient_sample` / `caution`: collect or use a larger split before
  treating the apparent headroom as an investment decision.

The top-level `gate.worth_investing` is true when at least one measurable band
has positive headroom. It is a screening gate, not evidence that a particular
training method will improve the model.

## Workflow integration

This is a deterministic, idempotent verifier step: consume a run artifact
reference and its SHA256, then emit the calibration report artifact. Pass only
artifact references and hashes through workflow state; never pass raw traces or
prompts through workflow state.
