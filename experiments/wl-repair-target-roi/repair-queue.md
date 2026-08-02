# Repair target queue

Generated 2026-08-02T02:52:21.192Z; 30-day requested window; candidate model `accounts/fireworks/models/glm-5p2`.
Population quantities are projected from a 0.679% uniform sample (population scale 147.351); share-based factors remain sample statistics.
Sampling method: uniform random sample stratified by day; fixed seed; 6,000 sampled captures, implied population 884,108 captures.
Effective observed window: 2026-07-04T03:30:23.028Z to 2026-08-02T01:55:39.151Z (28.934 days).
Rate card provenance: evidence-derived observed upstream billing; checked 2026-08-02.

## How to read this

Headroom is a heuristic prior, not measured quality. Savings are projections from the observed N-day window at the supplied rate-card prices. Conservative savings cover only addressable repeated-task clusters; optimistic savings cover all traffic. Rows with incomplete pricing show no savings number.

## Ranked by ROI score

| Rank | Workload | ROI | Conservative savings / 30d | Optimistic savings / 30d | Volume | Repeatability | Headroom prior | Cost delta | Confidence | Token source | No opportunity | Fallback rates |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | workload-j ⚠ | 0.2947 | $138.77 | $138.77 | 48,921 | 0.836 | 0.822 | 0.592 | 1.000 | mixed (77.1% observed) | — | claude-sonnet-5 R²=0.368062 |
| 2 | workload-h ⚠ | 0.0932 | $221.31 | $504.09 | 12,083 | 0.266 | 0.835 | 0.762 | 1.000 | mixed (97.6% observed) | — | claude-sonnet-5 R²=0.368062 |
| 3 | workload-o ⚠ | 0.0739 | $1053.21 | $1053.21 | 36,396 | 0.194 | 0.734 | 0.754 | 1.000 | mixed (96.0% observed) | — | claude-sonnet-5 R²=0.368062 |
| 4 | workload-g ⚠ | 0.0613 | $1777.90 | $1865.78 | 40,669 | 0.145 | 0.722 | 0.836 | 1.000 | mixed (98.9% observed) | — | claude-sonnet-5 R²=0.368062 |
| 5 | workload-a ⚠ | 0.0546 | $4520.91 | $5238.21 | 81,780 | 0.138 | 0.825 | 0.608 | 1.000 | mixed (99.5% observed) | — | claude-sonnet-5 R²=0.368062 |
| 6 | workload-c ⚠ | 0.0546 | $125.23 | $328.74 | 9,283 | 0.208 | 0.805 | 0.630 | 1.000 | mixed (98.4% observed) | — | claude-sonnet-5 R²=0.368062 |
| 7 | workload-k | 0.0356 | $0.00 | $266.87 | 3,242 | 0.558 | 0.375 | 0.436 | 1.000 | observed (100.0% observed) | — | — |
| 8 | workload-i ⚠ | 0.0273 | $0.00 | $9.27 | 295 | 1.000 | 0.451 | 0.442 | 0.316 | observed (100.0% observed) | — | — |
| 9 | workload-l ⚠ | 0.0244 | $0.00 | $112.14 | 2,210 | 0.333 | 0.490 | 0.433 | 0.866 | observed (100.0% observed) | — | claude-sonnet-5 R²=0.368062 |
| 10 | workload-d ⚠ | 0.0093 | $0.00 | $2.32 | 295 | 0.500 | 0.581 | 0.232 | 0.316 | mixed (50.0% observed) | — | — |
| 11 | workload-f ⚠ | 0.0000 | $0.00 | $0.00 | 449,422 | 0.411 | 0.740 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 12 | workload-b ⚠ | 0.0000 | $0.00 | $0.00 | 149,562 | 0.305 | 0.917 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 13 | workload-p ⚠ | 0.0000 | $0.00 | $0.00 | 14,735 | 1.000 | 0.879 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 14 | workload-m ⚠ | 0.0000 | $0.00 | $0.00 | 12,672 | 1.000 | 0.939 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |
| 15 | workload-n ⚠ | 0.0000 | $0.00 | $0.00 | 6,189 | 1.000 | 0.483 | 0.000 | 1.000 | mixed (81.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |
| 16 | workload-e ⚠ | 0.0000 | $0.00 | $0.00 | 16,356 | 1.000 | 0.876 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |

## Ranked by projected optimistic savings

| Rank | Workload | ROI | Conservative savings / 30d | Optimistic savings / 30d | Volume | Repeatability | Headroom prior | Cost delta | Confidence | Token source | No opportunity | Fallback rates |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 1 | workload-a ⚠ | 0.0546 | $4520.91 | $5238.21 | 81,780 | 0.138 | 0.825 | 0.608 | 1.000 | mixed (99.5% observed) | — | claude-sonnet-5 R²=0.368062 |
| 2 | workload-g ⚠ | 0.0613 | $1777.90 | $1865.78 | 40,669 | 0.145 | 0.722 | 0.836 | 1.000 | mixed (98.9% observed) | — | claude-sonnet-5 R²=0.368062 |
| 3 | workload-o ⚠ | 0.0739 | $1053.21 | $1053.21 | 36,396 | 0.194 | 0.734 | 0.754 | 1.000 | mixed (96.0% observed) | — | claude-sonnet-5 R²=0.368062 |
| 4 | workload-h ⚠ | 0.0932 | $221.31 | $504.09 | 12,083 | 0.266 | 0.835 | 0.762 | 1.000 | mixed (97.6% observed) | — | claude-sonnet-5 R²=0.368062 |
| 5 | workload-c ⚠ | 0.0546 | $125.23 | $328.74 | 9,283 | 0.208 | 0.805 | 0.630 | 1.000 | mixed (98.4% observed) | — | claude-sonnet-5 R²=0.368062 |
| 6 | workload-k | 0.0356 | $0.00 | $266.87 | 3,242 | 0.558 | 0.375 | 0.436 | 1.000 | observed (100.0% observed) | — | — |
| 7 | workload-j ⚠ | 0.2947 | $138.77 | $138.77 | 48,921 | 0.836 | 0.822 | 0.592 | 1.000 | mixed (77.1% observed) | — | claude-sonnet-5 R²=0.368062 |
| 8 | workload-l ⚠ | 0.0244 | $0.00 | $112.14 | 2,210 | 0.333 | 0.490 | 0.433 | 0.866 | observed (100.0% observed) | — | claude-sonnet-5 R²=0.368062 |
| 9 | workload-i ⚠ | 0.0273 | $0.00 | $9.27 | 295 | 1.000 | 0.451 | 0.442 | 0.316 | observed (100.0% observed) | — | — |
| 10 | workload-d ⚠ | 0.0093 | $0.00 | $2.32 | 295 | 0.500 | 0.581 | 0.232 | 0.316 | mixed (50.0% observed) | — | — |
| 11 | workload-f ⚠ | 0.0000 | $0.00 | $0.00 | 449,422 | 0.411 | 0.740 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 12 | workload-b ⚠ | 0.0000 | $0.00 | $0.00 | 149,562 | 0.305 | 0.917 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 13 | workload-p ⚠ | 0.0000 | $0.00 | $0.00 | 14,735 | 1.000 | 0.879 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | gpt-4o R²=-0.015066 |
| 14 | workload-m ⚠ | 0.0000 | $0.00 | $0.00 | 12,672 | 1.000 | 0.939 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |
| 15 | workload-n ⚠ | 0.0000 | $0.00 | $0.00 | 6,189 | 1.000 | 0.483 | 0.000 | 1.000 | mixed (81.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |
| 16 | workload-e ⚠ | 0.0000 | $0.00 | $0.00 | 16,356 | 1.000 | 0.876 | 0.000 | 1.000 | observed (100.0% observed) | candidate_not_cheaper | claude-sonnet-5 R²=0.368062 |

⚠ Some rows depend on blended-fallback rate-card entries. Their incumbent dollars are less reliable than rows using clean NNLS rates.

Scores are aggregates only. ROI is the product of volume, repeatability, incumbent-headroom heuristic prior, and serving-cost delta. Savings are projections, not billing statements.

## Repeatability diagnosis

The initial coarse fingerprint split multi-turn conversations by alternating role depth. In the top workloads, captures sharing the same masked system prompt, endpoint, tool set, and request shape produced multiple task fingerprints whose only observed difference was role-skeleton depth. The selector now uses the set of message roles for the coarse task fingerprint; the full role skeleton remains in the variant fingerprint.

| Alias | Before HHI | After HHI | Before rank | After rank | Captures in role-depth fanout groups |
| --- | ---: | ---: | ---: | ---: | ---: |
| workload-j | 0.836 | 0.836 | 1 | 1 | 0 |
| workload-o | 0.135 | 0.194 | 2 | 3 | 247 |
| workload-g | 0.094 | 0.145 | 3 | 4 | 276 |
| workload-h | 0.096 | 0.266 | 4 | 2 | 82 |
| workload-c | 0.078 | 0.208 | 5 | 6 | 63 |

Usage parsing: all 6,000 response bodies were strings; 5,965 parsed JSON response bodies contained provider usage, 35 were SSE-framed, and SSE usage was recovered from all 35. The remaining 139 captures lacked complete usage and retain estimated token accounting; mixed rows show their observed-token share.

## Projection vs observed billing

Observed billing is the full-population ClickHouse spend for the same window, normalized to 30 days. Ratios below 0.5 or above 2.0 need caution; they indicate sampling/token/rate-card variance rather than an invoice claim.

| Alias | Selector incumbent / 30d | Observed billing / 30d | Selector / observed | Full-window events |
| --- | ---: | ---: | ---: | ---: |
| workload-j | $234.26 | $521.30 | 0.449 | 36,702 |
| workload-h | $661.52 | $693.21 | 0.954 | 13,289 |
| workload-o | $1396.65 | $1569.88 | 0.890 | 38,397 |
| workload-g | $2231.28 | $2220.72 | 1.005 | 37,329 |
| workload-a | $8609.03 | $7082.37 | 1.216 | 82,004 |
| workload-c | $521.94 | $409.06 | 1.276 | 7,078 |
| workload-k | $612.72 | $420.11 | 1.458 | 2,471 |
| workload-i | $20.98 | $50.60 | 0.415 | 770 |
| workload-l | $258.72 | $340.86 | 0.759 | 2,820 |
| workload-d | $9.96 | $7.61 | 1.310 | 361 |
| workload-f | $15174.23 | $14923.59 | 1.017 | 451,699 |
| workload-b | $1124.54 | $1268.70 | 0.886 | 148,930 |
| workload-p | $130.99 | $201.06 | 0.652 | 14,046 |
| workload-m | $26.57 | $73.36 | 0.362 | 12,261 |
| workload-n | $90.84 | $203.42 | 0.447 | 5,242 |
| workload-e | $55.34 | $198.24 | 0.279 | 15,430 |

The largest divergences are retained in the table for review: `workload-e`, `workload-m`, `workload-n`, `workload-i`, and `workload-j` are below 0.5x. Their sample token/mix estimates are not strong enough to treat the projected dollars as billing truth.

## Candidate scenarios

The primary scenario uses the observed-traffic open-weight candidate. The second uses an American open-weight target-family candidate priced from the published provider table: [Fireworks serverless pricing](https://docs.fireworks.ai/serverless/pricing), checked 2026-08-02. The published table lists input / cached input / output; cache creation uses the input price conservatively in that scenario.

### Observed-traffic candidate

Candidate: `accounts/fireworks/models/glm-5p2`

| Rank | Alias | ROI | Conservative / optimistic savings | Repeatability | Token source |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | workload-j | 0.2947 | $138.77 / $138.77 | 0.836 | mixed (77.1% observed) |
| 2 | workload-h | 0.0932 | $221.31 / $504.09 | 0.266 | mixed (97.6% observed) |
| 3 | workload-o | 0.0739 | $1053.21 / $1053.21 | 0.194 | mixed (96.0% observed) |
| 4 | workload-g | 0.0613 | $1777.90 / $1865.78 | 0.145 | mixed (98.9% observed) |
| 5 | workload-a | 0.0546 | $4520.91 / $5238.21 | 0.138 | mixed (99.5% observed) |

### American open-weight target family

Candidate: `accounts/fireworks/models/nemotron-3-ultra-nvfp4`

| Rank | Alias | ROI | Conservative / optimistic savings | Repeatability | Token source |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | workload-p | 0.2913 | $75.48 / $75.48 | 1.000 | observed (100.0% observed) |
| 2 | workload-j | 0.2029 | $95.57 / $95.57 | 0.836 | mixed (77.1% observed) |
| 3 | workload-f | 0.1871 | $9312.41 / $9321.58 | 0.411 | observed (100.0% observed) |
| 4 | workload-b | 0.1458 | $679.52 / $679.52 | 0.305 | observed (100.0% observed) |
| 5 | workload-m | 0.0882 | $4.48 / $4.48 | 1.000 | observed (100.0% observed) |

### Savings ordering

The full tables above include ROI ordering and projected-savings ordering. The savings ordering is intentionally separate: ROI prioritizes the product of volume, repeatability, heuristic headroom, and cost delta, while savings ordering prioritizes projected dollars.

### Rate-card fit caveat

Rows marked with a fallback warning depend on blended-effective rates. The weakest fits were high-volume mixed observations: one model had R² `-0.015066` and another `0.368062`. This is consistent with heterogeneous billing behavior across the window (cache-tier and/or price-routing mixtures), so those dollars should be treated as directional until a segmented rate card is available.
