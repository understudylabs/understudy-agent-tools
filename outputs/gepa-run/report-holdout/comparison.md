| metric | base | gepa | null-floor | delta vs first arm |
| --- | --- | --- | --- | --- |
| mean score | 0.6698 | 0.9083 | 0.0000 | 0.2385 |
| exact-1 rate | 0.5500 | 0.8500 | 0.0000 | 0.3000 |
| zero rate | 0.2000 | 0.0500 | 1.0000 | -0.1500 |
| forbidden-effect rate | 0.0000 | 0.0167 | 0.0000 | 0.0167 |
| malformed rate | 0.8833 | 0.9000 | 0.0000 | 0.0167 |
| mean steps/rollout | 4.9500 | 4.9667 | 0.0000 | 0.0167 |
| mean tool calls/rollout | 4.9500 | 4.9667 | 0.0000 | 0.0167 |
| prompt tokens/rollout | 14597.0833 | 16220.6833 | 0.0000 | 1623.6000 |
| completion tokens/rollout | 2891.0333 | 2341.1333 | 0.0000 | -549.9000 |
| wall-clock s/rollout | 13.2167 | 11.1500 | 0.0000 | -2.0667 |

### Per-band mean
| band | base | gepa | null-floor | delta vs first arm |
| --- | --- | --- | --- | --- |
| aggregation | 0.7500 | 0.7500 | 0.0000 | 0.0000 |
| cascade | 0.5625 | 0.9375 | 0.0000 | 0.3750 |
| conditional | 0.8125 | 0.8750 | 0.0000 | 0.0625 |
| cross-record | 0.7917 | 0.8333 | 0.0000 | 0.0417 |
| discovery | 0.7500 | 1.0000 | 0.0000 | 0.2500 |
| long-chain | 0.4405 | 0.8750 | 0.0000 | 0.4345 |
| multi-hop | 0.6250 | 1.0000 | 0.0000 | 0.3750 |
| multi-write | 0.5417 | 1.0000 | 0.0000 | 0.4583 |
| single-write | 0.7500 | 1.0000 | 0.0000 | 0.2500 |

### Bootstrap intervals
- base: 95% CI [0.5667, 0.7716], n=60
- gepa: 95% CI [0.8375, 0.9625], n=60
- null-floor: 95% CI [0.0000, 0.0000], n=60
- Paired delta gepa - base: 95% CI [0.1282, 0.3484], n=60
