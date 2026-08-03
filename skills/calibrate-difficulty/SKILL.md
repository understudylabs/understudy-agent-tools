---
name: calibrate-difficulty
description: Measure per-band model headroom from a local, source-bound run artifact before investing in training.
---

# Calibrate difficulty

Use an existing local run artifact with explicit generic `band` labels. The
artifact is hashed and the report records that source binding. This is a
deterministic screening step: it makes no provider calls, never reads holdout
or customer data, and does not infer bands from benchmark-specific task IDs.

```bash
npm run build
node scripts/difficulty-calibration.mjs --run path/to/synthetic-run.json --out report.json
```

Scores at or above `0.95` are saturated only when the band has at least 10
scored rows; insufficient sample takes precedence and remains `caution`.
Only sufficiently sampled bands below the threshold are `measurable` and
`invest`. Keep fixture, split, scoring protocol, and source hash visible, and
use dev/train data for decisions—never holdout data.

## Safety Gates

- Use only a frozen, source-bound train/dev run. Never use holdout rows or make
  provider calls from this calibration step.
- Predeclare the saturation threshold and minimum sample. An undersized band is
  `insufficient_sample` even when its observed mean is perfect.
- Treat the report as a spend-routing screen, not promotion evidence or proof
  that a model can beat the incumbent.

## Resolve CLI

Build before invoking the repository-local script:

```bash
npm run build
node scripts/difficulty-calibration.mjs \
  --run path/to/source-bound-dev-run.json \
  --threshold 0.95 --min-sample 10 --out report.json
```

The script hashes the exact input bytes and writes a deterministic calibration
report apart from `generated_at`.
