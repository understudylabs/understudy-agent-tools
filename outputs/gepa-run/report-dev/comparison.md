| metric | base | gepa | null-floor | delta vs first arm |
| --- | --- | --- | --- | --- |
| mean score | 0.5929 | 0.8750 | 0.0000 | 0.2821 |
| exact-1 rate | 0.5278 | 0.8333 | 0.0000 | 0.3056 |
| zero rate | 0.3333 | 0.0833 | 1.0000 | -0.2500 |
| forbidden-effect rate | 0.0278 | 0.0000 | 0.0000 | -0.0278 |
| malformed rate | 0.9167 | 0.7500 | 0.0000 | -0.1667 |
| mean steps/rollout | 4.6667 | 4.4444 | 0.0000 | -0.2222 |
| mean tool calls/rollout | 4.6667 | 4.4444 | 0.0000 | -0.2222 |
| prompt tokens/rollout | 12871.6389 | 12173.3889 | 0.0000 | -698.2500 |
| completion tokens/rollout | 2786.9444 | 2035.7222 | 0.0000 | -751.2222 |
| wall-clock s/rollout | 15.6944 | 16.3333 | 0.0000 | 0.6389 |

### Per-band mean
| band | base | gepa | null-floor | delta vs first arm |
| --- | --- | --- | --- | --- |
| aggregation | 1.0000 | 0.7500 | 0.0000 | -0.2500 |
| cascade | 0.4375 | 0.7500 | 0.0000 | 0.3125 |
| conditional | 0.5000 | 0.7500 | 0.0000 | 0.2500 |
| cross-record | 0.5833 | 0.8333 | 0.0000 | 0.2500 |
| discovery | 1.0000 | 1.0000 | 0.0000 | 0.0000 |
| long-chain | 0.1071 | 0.7500 | 0.0000 | 0.6429 |
| multi-hop | 0.2500 | 1.0000 | 0.0000 | 0.7500 |
| multi-write | 0.9167 | 1.0000 | 0.0000 | 0.0833 |
| single-write | 0.7500 | 1.0000 | 0.0000 | 0.2500 |

### Bootstrap intervals
- base: 95% CI [0.4375, 0.7414], n=36
- gepa: 95% CI [0.7639, 0.9583], n=36
- null-floor: 95% CI [0.0000, 0.0000], n=36
- Paired delta gepa - base: 95% CI [0.1200, 0.4487], n=36
