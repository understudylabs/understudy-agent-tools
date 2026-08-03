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
