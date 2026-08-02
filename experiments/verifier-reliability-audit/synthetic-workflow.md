## Verifier reliability audit — synthetic-workflow-offline

An RL/DPO lift may only be believed on bands whose verdict is `trusted`.
Untrusted bands need reward shaping or a process reward before reporting a lift.
FP/FN rates are conditional on this adversarial suite composition; they are stress-test measures, not estimates over a natural policy distribution.

| Band | Probes | FP rate | FN rate | MCC | Max true-failure reward | Disagreements | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| discovery | 260 | 0.135135135135 | 0.333333333333 | 0.531531531532 | 1 | 0 | insufficient-evidence |
| single-write | 160 | 0.086956521739 | 0.333333333333 | 0.601929265429 | 1 | 0 | insufficient-evidence |
| multi-write | 300 | 0.111111111111 | 0.266666666667 | 0.609271795845 | 1 | 0 | insufficient-evidence |

### Probe-family decomposition

| Band | Family | Probes | True failures | FP rate | FN rate |
| --- | --- | ---: | ---: | ---: | ---: |
| discovery | oracle | 25 | 0 | null | 0 |
| discovery | noop | 25 | 25 | 0 | null |
| discovery | prefix | 50 | 50 | 0 | null |
| discovery | oracle-with-reads | 25 | 0 | null | 0 |
| discovery | search-spam | 25 | 25 | 0 | null |
| discovery | sentinel-clobber | 25 | 25 | 0 | null |
| discovery | wrong-value | 25 | 25 | 0 | null |
| discovery | collection-spam | 20 | 20 | 1 | null |
| discovery | write-then-revert | 25 | 0 | null | 1 |
| discovery | revert-after-gold | 5 | 5 | 0 | null |
| discovery | wrong-target | 5 | 5 | 0 | null |
| discovery | in-scope-clobber | 5 | 5 | 1 | null |
| single-write | oracle | 15 | 0 | null | 0 |
| single-write | noop | 15 | 15 | 0 | null |
| single-write | prefix | 25 | 25 | 0 | null |
| single-write | revert-after-gold | 10 | 10 | 0 | null |
| single-write | oracle-with-reads | 15 | 0 | null | 0 |
| single-write | search-spam | 15 | 15 | 0 | null |
| single-write | sentinel-clobber | 15 | 15 | 0 | null |
| single-write | wrong-value | 10 | 10 | 0 | null |
| single-write | wrong-target | 10 | 10 | 0 | null |
| single-write | in-scope-clobber | 15 | 15 | 0.666666666667 | null |
| single-write | write-then-revert | 15 | 0 | null | 1 |
| multi-write | oracle | 20 | 0 | null | 0 |
| multi-write | noop | 20 | 20 | 0 | null |
| multi-write | prefix | 90 | 90 | 0 | null |
| multi-write | oracle-with-reads | 15 | 0 | null | 0 |
| multi-write | oracle-reordered | 20 | 0 | null | 0 |
| multi-write | search-spam | 20 | 20 | 0 | null |
| multi-write | sentinel-clobber | 20 | 20 | 0 | null |
| multi-write | wrong-value | 20 | 20 | 0 | null |
| multi-write | wrong-target | 15 | 15 | 0 | null |
| multi-write | in-scope-clobber | 20 | 20 | 0.25 | null |
| multi-write | collection-spam | 20 | 20 | 1 | null |
| multi-write | write-then-revert | 20 | 0 | null | 1 |

Natural arm replay-fidelity mismatches: 0

Natural-arm rates are measured on recorded model trajectories, separately from the adversarial stress suite.
