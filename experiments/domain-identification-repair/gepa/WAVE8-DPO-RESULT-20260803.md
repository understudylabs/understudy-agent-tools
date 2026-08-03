# Wave 8 DPO repaired-dev result

Status: **dev promotion eligible**. This is not production-replacement or
holdout evidence.

## Result

Run `wave8-dpo-20260803T073222Z` improved the Nemotron student from `0.854167`
to `0.958333` on the same repaired canonical dev protocol (`k=3`, temperature
0). The protected-family scores are direct `1.0`, lookalike `1.0`, parent
`1.0`, and unmatched `0.833333`. The confirmation recorded zero forbidden
writes and zero runtime errors.

The winning checkpoint is
`tinker://3f538eaa-22a5-5c9b-ad65-d0e82e865fd1:train:0/sampler_weights/final`.
Training used 44 validated train-only DPO pairs, rank 32, beta `0.1`, three
epochs, batch size 4, and learning rate `1e-5`. Training wall time was 374.5
seconds.

## Provenance

- Source commit: `33ce4f396fe4c8be0ccbc02bf38179262b8e5d6f`
- Fixture SHA-256: `3b996e126603f4200f6fa1b01e0d084c3c3a7e694246f77687b76ff15d863de2`
- Train split SHA-256: `b358c36f429303d64bb9309a685f78ddfd03bd1602cbf415e8dd1e977ac93017`
- Dev split SHA-256: `3934011a2182ac6d4b32e7016b705cb908e21c2c1ae469f3b0e116ed7bc345a2`
- System prompt SHA-256: `cd718da1b0189d2153c24dabd78e00bd0b99ae3779c433cf2c7de47246dc1493`
- Validated normalized-pairs SHA-256: `a9e2cf5cc61ce34a47750eb76daf4eb22a4c44be11d199c15a181c4f6bc00f36`

The immutable receipt bundle and `SHA256SUMS.txt` are on Spark Alpha at
`/home/understudy/services/gepa-viz/runs/wave8-dpo-20260803T073222Z/`.
Local and Alpha checksum verification passed for the pair manifest, validator
receipt, training receipt, baseline and optimized canonical evaluations,
promotion receipt, and experiment manifest.

## Serving decision

Across 4,075 observed rollout samples, the Tinker lane measured p50 `5.099s`
and p95 `13.394s`, with no service-pressure failure cluster in the terminal
manifest. That is materially faster than the earlier 42.72s/71.01s lane and
does not currently justify standing up Modal or GCP solely for wall-clock
acceleration. Revisit deployment only if a future diversity-capable wave shows
sustained queueing, 429/5xx/timeouts, or serving latency again dominates the
parallel optimizer.

Tinker billing usage is eventually consistent and returned no rows on the
first reconciliation query. The dashboard therefore reports `cost_usd=null`
and `cost_coverage=tinker receipt pending`; no dollar total is inferred.

## Holdout boundary

Wave 8 did not construct or execute a fresh holdout. The historical holdout
was already observed, so it is not sealed promotion evidence. The authoritative
manifest reports `holdout_untouched=false`,
`holdout_status=historical_holdout_observed`, and
`totals.holdout_executed=false`. A production replacement decision requires a
new, separately authorized, hash-bound holdout and serving-parity evidence.

## Live view

The unified monitor is available to the tailnet at
`http://spark-246e.taila24722.ts.net:5151/monitor/index.html`.
