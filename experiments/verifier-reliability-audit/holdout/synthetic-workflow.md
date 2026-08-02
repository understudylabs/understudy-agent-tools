## Verifier reliability audit — synthetic-workflow-offline

An RL/DPO lift may only be believed on bands whose verdict is `trusted`.
Untrusted bands need reward shaping or a process reward before reporting a lift.
FP/FN rates are conditional on this adversarial suite composition; they are stress-test measures, not estimates over a natural policy distribution.

| Band | Probes | FP rate | FN rate | MCC | Max true-failure reward | Disagreements | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| discovery | 52 | 0.135135135135 | 0.333333333333 | 0.531531531532 | 1 | 0 | insufficient-evidence |
| single-write | 32 | 0.086956521739 | 0.333333333333 | 0.601929265429 | 1 | 0 | insufficient-evidence |
| multi-write | 60 | 0.111111111111 | 0.266666666667 | 0.609271795845 | 1 | 0 | insufficient-evidence |

### Probe-family decomposition

| Band | Family | Probes | True failures | FP rate | FN rate |
| --- | --- | ---: | ---: | ---: | ---: |
| discovery | oracle | 5 | 0 | null | 0 |
| discovery | noop | 5 | 5 | 0 | null |
| discovery | prefix | 10 | 10 | 0 | null |
| discovery | oracle-with-reads | 5 | 0 | null | 0 |
| discovery | search-spam | 5 | 5 | 0 | null |
| discovery | sentinel-clobber | 5 | 5 | 0 | null |
| discovery | wrong-value | 5 | 5 | 0 | null |
| discovery | collection-spam | 4 | 4 | 1 | null |
| discovery | write-then-revert | 5 | 0 | null | 1 |
| discovery | revert-after-gold | 1 | 1 | 0 | null |
| discovery | wrong-target | 1 | 1 | 0 | null |
| discovery | in-scope-clobber | 1 | 1 | 1 | null |
| single-write | oracle | 3 | 0 | null | 0 |
| single-write | noop | 3 | 3 | 0 | null |
| single-write | prefix | 5 | 5 | 0 | null |
| single-write | revert-after-gold | 2 | 2 | 0 | null |
| single-write | oracle-with-reads | 3 | 0 | null | 0 |
| single-write | search-spam | 3 | 3 | 0 | null |
| single-write | sentinel-clobber | 3 | 3 | 0 | null |
| single-write | wrong-value | 2 | 2 | 0 | null |
| single-write | wrong-target | 2 | 2 | 0 | null |
| single-write | in-scope-clobber | 3 | 3 | 0.666666666667 | null |
| single-write | write-then-revert | 3 | 0 | null | 1 |
| multi-write | oracle | 4 | 0 | null | 0 |
| multi-write | noop | 4 | 4 | 0 | null |
| multi-write | prefix | 18 | 18 | 0 | null |
| multi-write | oracle-with-reads | 3 | 0 | null | 0 |
| multi-write | oracle-reordered | 4 | 0 | null | 0 |
| multi-write | search-spam | 4 | 4 | 0 | null |
| multi-write | sentinel-clobber | 4 | 4 | 0 | null |
| multi-write | wrong-value | 4 | 4 | 0 | null |
| multi-write | wrong-target | 3 | 3 | 0 | null |
| multi-write | in-scope-clobber | 4 | 4 | 0.25 | null |
| multi-write | collection-spam | 4 | 4 | 1 | null |
| multi-write | write-then-revert | 4 | 0 | null | 1 |

Natural arm replay-fidelity mismatches: 0

Natural-arm rates are measured on recorded model trajectories, separately from the adversarial stress suite.
