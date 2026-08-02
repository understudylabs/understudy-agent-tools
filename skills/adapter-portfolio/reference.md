# Adapter Portfolio Reference

The base-model transfer set contains one base reference for each suite in the
union of the candidate suite and every currently promoted adapter's suite.
Each reference is a `subject: "base"` holdout row with no candidate in
`context.loaded_adapters`.

Each previously promoted adapter contributes one reference on its own suite:
`subject: "adapter"`, `adapter_name` equal to that adapter, and `split:
"holdout"`. The candidate must then have a later recheck row for every
reference with the candidate name in `context.loaded_adapters`.

The candidate's own dev and holdout rows are adapter-subject rows on its
registered suite. Dev selects the best recorded candidate row, but holdout
selection is deliberately worst-of-N: if the candidate has multiple holdout
runs, the lowest score is used and the gate says so explicitly. This prevents
re-running a sealed holdout and cherry-picking a favorable result. The
holdout row must use the exact recorded holdout SHA-256 and row count. The
recorded timestamp is also used to enforce that dev came before holdout.

The exact no-forgetting baseline set is:

- one base holdout reference for every suite in the candidate suite plus every
  currently promoted adapter's suite;
- one holdout reference for each currently promoted adapter on that adapter's
  own suite.

References exclude the candidate from `context.loaded_adapters`. Each baseline
requires a later recheck with the candidate loaded, and the recheck may not
fall below the reference by more than `max_regression`. The candidate's
`min_lift_vs_base` requirement applies to both dev and holdout when an
uncontaminated base row exists.

Example:

```bash
understudy adapter-portfolio init \
  --min-dev-score 0.80 \
  --min-holdout-score 0.78 \
  --max-regression 0.02

understudy adapter-portfolio register \
  --name adapter-a \
  --path ./artifacts/adapter-a \
  --base base-model \
  --suite workload-band-a \
  --method sft-lora \
  --holdout-path ./splits/holdout.jsonl \
  --holdout-sha256 <64-hex-sha256> \
  --holdout-rows 40

understudy adapter-portfolio candidate adapter-a

understudy adapter-portfolio evidence add \
  --adapter adapter-a --suite workload-band-a --split dev \
  --score 0.84 --metric score --dataset-sha256 <64-hex-sha256> \
  --rows 80 --seed 7

understudy adapter-portfolio evidence add \
  --adapter adapter-a --suite workload-band-a --split holdout \
  --score 0.81 --metric score --dataset-sha256 <holdout-sha256> \
  --rows 40 --seed 7

understudy adapter-portfolio gate adapter-a --json
understudy adapter-portfolio promote adapter-a --dry-run --json
```

Serving names may be placed in `loaded_adapters`; the portfolio does not
configure serving endpoints or placement.
