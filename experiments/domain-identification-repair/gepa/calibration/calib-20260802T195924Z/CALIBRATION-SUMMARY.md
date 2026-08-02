# Domain-identification harness-parity calibration summary

**State:** calibration_complete — 48 episodes (8 dev tasks x 3 reps x 2 paths). seed_control=False.

## Scores (seed prompt, identical config)

| path | rep1 | rep2 | rep3 | mean | range | stdev |
|---|---|---|---|---|---|---|
| canonical rollout.mjs | 0.625 | 0.5625 | 0.75 | 0.6458 | [0.5625, 0.75] | 0.078 |
| GEPA ContractAdapter | 0.5 | 0.5 | 0.75 | 0.5833 | [0.5, 0.75] | 0.1179 |

Original baseline nemotron-dev = 0.75; GEPA checkpoint seed = 0.50. Both are inside the observed variance band.

## Per-band mean (avg over 3 reps)

| band | canonical | adapter |
|---|---|---|
| direct-match | 0.8333 | 0.6667 |
| near-match | 0.8333 | 1.0 |
| parent-join | 0.6667 | 0.5 |
| abstain | 0.25 | 0.1667 |

## Paired per-task disagreement
4/24 paired episodes disagree (rate 0.1667).

| task_id | band | canon scores | adapter scores | agree/3 | canon mf_total | adapter mf_total |
|---|---|---|---|---|---|---|
| domain-id-direct-route-07 | direct-match | [1.0, 1.0, 1.0] | [1.0, 1.0, 1.0] | 3 | [1, 2, 2] | [2, 2, 1] |
| domain-id-direct-route-08 | direct-match | [0.0, 1.0, 1.0] | [0.0, 1.0, 0.0] | 2 | [3, 3, 2] | [4, 3, 3] |
| domain-id-lookalike-route-07 | near-match | [1.0, 1.0, 1.0] | [1.0, 1.0, 1.0] | 3 | [1, 3, 2] | [1, 1, 2] |
| domain-id-lookalike-route-08 | near-match | [1.0, 1.0, 0.0] | [1.0, 1.0, 1.0] | 2 | [2, 4, 5] | [4, 3, 6] |
| domain-id-parent-route-07 | parent-join | [1.0, 0.0, 1.0] | [1.0, 0.0, 1.0] | 3 | [2, 3, 2] | [2, 5, 2] |
| domain-id-parent-route-08 | parent-join | [1.0, 0.0, 1.0] | [0.0, 0.0, 1.0] | 2 | [2, 4, 2] | [5, 4, 2] |
| domain-id-unmatched-abstain-07 | abstain | [0.0, 0.5, 1.0] | [0.0, 0.0, 1.0] | 2 | [4, 4, 2] | [2, 3, 2] |
| domain-id-unmatched-abstain-08 | abstain | [0.0, 0.0, 0.0] | [0.0, 0.0, 0.0] | 3 | [3, 4, 2] | [2, 2, 3] |

malformed_total per rep (uniform def) — canonical [18, 27, 19], adapter [22, 23, 21].

## Conclusion
Both paths span the same score range [0.50, 0.75] and both reach 0.75; the failing band rotates across reps. The 0.75-vs-0.50 gap is sampling variance at n=8 on a temp-0 nondeterministic endpoint, NOT a scoring-harness parity defect. Config, parser, turn cap, scorer, and env are identical across paths. Remaining real defect is a malformed-metric semantics mismatch (adapter reported trailing-consecutive, canonical reports cumulative).

## GEPA metric-call accounting

- budget 40; total_num_evals=40; num_full_ds_evals=1; iterations=7; candidates=1.
- Budget 40 = 8 (seed full dev eval) + ~7 iterations of 4-task reflection minibatch proposals (~32). No proposed mutation beat the seed on its minibatch gate, so none was promoted to a full-val eval or accepted; best stayed candidate 0 (seed). This is an honest 'no improvement found within budget', compounded by a tight budget.
- Minimum budget for one accepted mutation = 20 (8 seed + 4 minibatch + 8 full-val). 40 allows ~1-2 accepted candidates IF proposals pass the minibatch gate; recommend >=60-80 for a meaningful search with reflection_minibatch_size=4.
