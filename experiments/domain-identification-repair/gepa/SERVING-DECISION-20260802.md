# Eight-island GEPA serving decision

Decision date: 2026-08-02  
Experiment: `islands-20260802T234309Z`  
Workload: `domain_identification` train/dev only  
Serving lane: existing Tinker/Nemotron OpenAI-compatible shim  

## Measured evidence

The eight-island Stage-1 screen dispatched 96 rollouts at an observed peak of
32 concurrent requests. All 96 completed successfully:

| Metric | Result |
|---|---:|
| Per-rollout latency p50 | 42.7195 s |
| Per-rollout latency p95 | 71.0133 s |
| Per-rollout latency max | 105.8409 s |
| HTTP 429 | 0 |
| HTTP 5xx | 0 |
| Timeout | 0 |
| Stage-1 episodes | 96/96 |

The branch wall times (219.3–465.5 s) include sequential GEPA rounds and
reflection and are not inference latency. Cost remains out-of-band in
ClickHouse and must not be represented as a measured dollar total here.

## Decision

Do **not** migrate this experiment to Modal or GCP yet. The current lane
sustained the requested 32-way fan-out without service pressure. The run
stopped because all eight islands produced one globally deduplicated prompt,
not because serving constrained the search. A faster deployment would reduce
some rollout wall time but would not create candidate diversity or unlock
successive halving.

The next acceleration investment is search diversity: distinct seed prompts,
strategy-specific reflection instructions, and mutation sampling that cannot
silently return the incumbent unchanged. Revisit a dedicated deployment only
after a diversity-capable run shows either sustained 429/5xx/timeouts, queueing,
or a p95 rollout latency that dominates otherwise-parallel branch wall time.

## Claim boundary

- This is a serving-capacity decision, not a model-quality or promotion claim.
- Wave 1 remains the best canonical dev result at 0.7291667 (`k=3`).
- The eight Stage-1 island scores are screening-only and not rank eligible.
- Stage 2 and canonical finalist confirmation were not executed.
- The experiment did not execute holdout.

## 2026-08-03 update: Gateway DeepSeek lane and GEPA acceptance

The second corrected Nemotron run (`islands-20260803T000907Z`) again completed
96/96 Stage-1 episodes with no 429, 5xx, or timeout, but all eight accepted
outputs deduplicated to the seed. Artifact inspection proved that each island
generated and evaluated a distinct mutation; three exploratory mutations tied
the seed and were discarded by GEPA 0.0.27's strictly-better gate before the
runner could select them.

The optimizer runtime is therefore pinned to `gepa==0.1.4`. Exploit islands use
`strict_improvement`; explore and failure-targeted islands use
`improvement_or_equal`. This changes only the screening pool. Full-dev
canonical `k=3` remains the sole promotion authority.

In parallel, the managed Understudy Gateway route `deepseek-v4-flash` was
validated on the same dev fixture and serving contract:

| Prompt / protocol | Score | Malformed | Wall | Errors |
|---|---:|---:|---:|---:|
| Wave-1 prompt, k=1 scout | 0.7500 | 0.0% | 36 s | 0 |
| Default prompt, canonical k=3 | 0.7500 | 25.0% | 35 s | 0 |
| Wave-1 prompt, canonical k=3 | 0.7500 | 8.3% | 26 s | 0 |

DeepSeek already exceeds the current Wave-1 student on a matching canonical
dev `k=3` protocol (`0.7500` vs `0.7292`) and is much faster than the measured
Nemotron lane. Its remaining failures are isolated to the abstain band, making
it the preferred parallel GEPA target. This is not yet a Sonnet replacement
claim: the incumbent's `0.875` reference is `k=1` and cannot rank against these
`k=3` results. Gateway cost remains pending usage reconciliation. Holdout is
untouched.
