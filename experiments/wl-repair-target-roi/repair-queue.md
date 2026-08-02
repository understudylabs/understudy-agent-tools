# Repair target queue

Generated 2026-08-02T02:28:27.014Z; 30-day requested window; candidate model `accounts/fireworks/models/glm-5p2`.
Population quantities are projected from a 0.679% uniform sample (population scale 147.351); share-based factors remain sample statistics.
Sampling method: uniform random sample stratified by day; fixed seed; 6,000 sampled captures, implied population 884,108 captures.
Effective observed window: 2026-07-04T03:30:23.028Z to 2026-08-02T01:55:39.151Z (28.934 days).
Rate card provenance: evidence-derived observed upstream billing; checked 2026-08-02.

## How to read this

Headroom is a heuristic prior, not measured quality. Savings are projections from the observed N-day window at the supplied rate-card prices. Conservative savings cover only addressable repeated-task clusters; optimistic savings cover all traffic. Rows with incomplete pricing show no savings number.

| Rank | Workload | ROI | Conservative savings / 30d | Optimistic savings / 30d | Volume | Repeatability | Headroom prior | Cost delta | Confidence | Token source |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | workload-j | 0.2947 | $138.77 | $138.77 | 48,921 | 0.836 | 0.822 | 0.592 | 1.000 | estimated |
| 2 | workload-o | 0.0515 | $869.86 | $1053.21 | 36,396 | 0.135 | 0.734 | 0.754 | 1.000 | estimated |
| 3 | workload-g | 0.0398 | $1284.41 | $1865.78 | 40,669 | 0.094 | 0.722 | 0.836 | 1.000 | estimated |
| 4 | workload-h | 0.0337 | $0.00 | $504.09 | 12,083 | 0.096 | 0.835 | 0.762 | 1.000 | estimated |
| 5 | workload-c | 0.0206 | $0.00 | $328.74 | 9,283 | 0.078 | 0.805 | 0.630 | 1.000 | estimated |
| 6 | workload-a | 0.0151 | $2019.78 | $5238.21 | 81,780 | 0.038 | 0.825 | 0.608 | 1.000 | estimated |
| 7 | workload-i ⚠ | 0.0130 | $0.00 | $12.18 | 295 | 1.000 | 0.190 | 0.502 | 0.316 | estimated |
| 8 | workload-d ⚠ | 0.0093 | $0.00 | $2.32 | 295 | 0.500 | 0.581 | 0.232 | 0.316 | estimated |
| 9 | workload-l | 0.0052 | $0.00 | $220.88 | 2,210 | 0.120 | 0.272 | 0.465 | 0.866 | estimated |
| 10 | workload-k | 0.0023 | $0.00 | $348.94 | 3,242 | 0.128 | 0.100 | 0.456 | 1.000 | estimated |
| 11 | workload-f | 0.0000 | $0.00 | $0.00 | 449,422 | 0.408 | 0.740 | 0.000 | 1.000 | observed |
| 12 | workload-b | 0.0000 | $0.00 | $0.00 | 149,562 | 0.305 | 0.917 | 0.000 | 1.000 | observed |
| 13 | workload-p | 0.0000 | $0.00 | $0.00 | 14,735 | 1.000 | 0.879 | 0.000 | 1.000 | observed |
| 14 | workload-m | 0.0000 | $0.00 | $0.00 | 12,672 | 1.000 | 0.939 | 0.000 | 1.000 | observed |
| 15 | workload-n | 0.0000 | $0.00 | $0.00 | 6,189 | 1.000 | 0.483 | 0.000 | 1.000 | estimated |
| 16 | workload-e | 0.0000 | $0.00 | $0.00 | 16,356 | 1.000 | 0.876 | 0.000 | 1.000 | observed |

Scores are aggregates only. ROI is the product of volume, repeatability, incumbent-headroom heuristic prior, and serving-cost delta. Savings are projections, not billing statements.
