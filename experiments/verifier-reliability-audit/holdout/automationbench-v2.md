## Verifier reliability audit — automationbench-v2

An RL/DPO lift may only be believed on bands whose verdict is `trusted`.
Untrusted bands need reward shaping or a process reward before reporting a lift.
FP/FN rates are conditional on this adversarial suite composition; they are stress-test measures, not estimates over a natural policy distribution.

| Band | Probes | FP rate | FN rate | MCC | Max true-failure reward | Disagreements | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| single-write | 45 | 0.090909090909 | 0.333333333333 | 0.592449657765 | 1 | 0 | untrusted |
| discovery | 42 | 0.066666666667 | 0.333333333333 | 0.636396103068 | 1 | 0 | untrusted |
| multi-write | 51 | 0.111111111111 | 0.266666666667 | 0.622222222222 | 1 | 0 | untrusted |
| cross-record | 156 | 0.035714285714 | 0.272727272727 | 0.738622210987 | 1 | 0 | insufficient-evidence |
| multi-hop | 116 | 0.086956521739 | 0.333333333333 | 0.579710144928 | 1 | 0 | insufficient-evidence |
| cascade | 136 | 0.076923076923 | 0.25 | 0.673076923077 | 1 | 0 | insufficient-evidence |
| long-chain | 132 | 0.076923076923 | 0.285714285714 | 0.637362637363 | 1 | 0 | insufficient-evidence |
| conditional | 104 | 0.025641025641 | 0.307692307692 | 0.732467020765 | 1 | 0 | insufficient-evidence |
| aggregation | 48 | 0.111111111111 | 0.333333333333 | 0.555555555556 | 1 | 0 | insufficient-evidence |

### Probe-family decomposition

| Band | Family | Probes | True failures | FP rate | FN rate |
| --- | --- | ---: | ---: | ---: | ---: |
| single-write | oracle | 4 | 0 | null | 0 |
| single-write | noop | 4 | 4 | 0 | null |
| single-write | prefix | 5 | 5 | 0 | null |
| single-write | revert-after-gold | 4 | 4 | 0 | null |
| single-write | oracle-with-reads | 4 | 0 | null | 0 |
| single-write | search-spam | 4 | 4 | 0 | null |
| single-write | sentinel-clobber | 4 | 4 | 0 | null |
| single-write | wrong-value | 4 | 4 | 0 | null |
| single-write | wrong-target | 4 | 4 | 0 | null |
| single-write | in-scope-clobber | 4 | 4 | 0.75 | null |
| single-write | write-then-revert | 4 | 0 | null | 1 |
| discovery | oracle | 4 | 0 | null | 0 |
| discovery | noop | 4 | 4 | 0 | null |
| discovery | prefix | 4 | 4 | 0 | null |
| discovery | oracle-with-reads | 4 | 0 | null | 0 |
| discovery | search-spam | 4 | 4 | 0 | null |
| discovery | sentinel-clobber | 4 | 4 | 0 | null |
| discovery | wrong-value | 4 | 4 | 0 | null |
| discovery | collection-spam | 4 | 4 | 0.25 | null |
| discovery | write-then-revert | 4 | 0 | null | 1 |
| discovery | revert-after-gold | 2 | 2 | 0 | null |
| discovery | wrong-target | 2 | 2 | 0 | null |
| discovery | in-scope-clobber | 2 | 2 | 0.5 | null |
| multi-write | oracle | 4 | 0 | null | 0 |
| multi-write | noop | 4 | 4 | 0 | null |
| multi-write | prefix | 8 | 8 | 0 | null |
| multi-write | revert-after-gold | 2 | 2 | 0 | null |
| multi-write | oracle-with-reads | 4 | 0 | null | 0 |
| multi-write | oracle-reordered | 3 | 0 | null | 0 |
| multi-write | search-spam | 4 | 4 | 0 | null |
| multi-write | sentinel-clobber | 4 | 4 | 0 | null |
| multi-write | wrong-value | 4 | 4 | 0 | null |
| multi-write | wrong-target | 4 | 4 | 0 | null |
| multi-write | in-scope-clobber | 4 | 4 | 0.75 | null |
| multi-write | write-then-revert | 4 | 0 | null | 1 |
| multi-write | collection-spam | 2 | 2 | 0.5 | null |
| cross-record | oracle | 12 | 0 | null | 0 |
| cross-record | noop | 12 | 12 | 0 | null |
| cross-record | prefix | 28 | 28 | 0 | null |
| cross-record | revert-after-gold | 12 | 12 | 0 | null |
| cross-record | oracle-with-reads | 12 | 0 | null | 0 |
| cross-record | search-spam | 12 | 12 | 0 | null |
| cross-record | sentinel-clobber | 12 | 12 | 0 | null |
| cross-record | wrong-value | 12 | 12 | 0 | null |
| cross-record | wrong-target | 12 | 12 | 0 | null |
| cross-record | in-scope-clobber | 12 | 12 | 0.333333333333 | null |
| cross-record | write-then-revert | 12 | 0 | null | 1 |
| cross-record | oracle-reordered | 8 | 0 | null | 0 |
| multi-hop | oracle | 8 | 0 | null | 0 |
| multi-hop | noop | 8 | 8 | 0 | null |
| multi-hop | prefix | 28 | 28 | 0 | null |
| multi-hop | oracle-with-reads | 8 | 0 | null | 0 |
| multi-hop | oracle-reordered | 8 | 8 | 0 | null |
| multi-hop | search-spam | 8 | 8 | 0 | null |
| multi-hop | sentinel-clobber | 8 | 8 | 0 | null |
| multi-hop | wrong-value | 8 | 8 | 0 | null |
| multi-hop | wrong-target | 8 | 8 | 0 | null |
| multi-hop | in-scope-clobber | 8 | 8 | 1 | null |
| multi-hop | collection-spam | 8 | 8 | 0 | null |
| multi-hop | write-then-revert | 8 | 0 | null | 1 |
| cascade | oracle | 8 | 0 | null | 0 |
| cascade | noop | 8 | 8 | 0 | null |
| cascade | prefix | 44 | 44 | 0 | null |
| cascade | revert-after-gold | 8 | 8 | 0 | null |
| cascade | oracle-with-reads | 8 | 0 | null | 0 |
| cascade | oracle-reordered | 8 | 0 | null | 0 |
| cascade | search-spam | 8 | 8 | 0 | null |
| cascade | sentinel-clobber | 8 | 8 | 0 | null |
| cascade | wrong-value | 8 | 8 | 0 | null |
| cascade | wrong-target | 8 | 8 | 0 | null |
| cascade | in-scope-clobber | 8 | 8 | 1 | null |
| cascade | collection-spam | 4 | 4 | 0 | null |
| cascade | write-then-revert | 8 | 0 | null | 1 |
| long-chain | oracle | 8 | 0 | null | 0 |
| long-chain | noop | 8 | 8 | 0 | null |
| long-chain | prefix | 44 | 44 | 0 | null |
| long-chain | oracle-with-reads | 8 | 0 | null | 0 |
| long-chain | oracle-reordered | 8 | 4 | 0 | 0 |
| long-chain | search-spam | 8 | 8 | 0 | null |
| long-chain | sentinel-clobber | 8 | 8 | 0 | null |
| long-chain | wrong-value | 8 | 8 | 0 | null |
| long-chain | wrong-target | 8 | 8 | 0 | null |
| long-chain | in-scope-clobber | 8 | 8 | 1 | null |
| long-chain | collection-spam | 8 | 8 | 0 | null |
| long-chain | write-then-revert | 8 | 0 | null | 1 |
| conditional | oracle | 8 | 0 | null | 0 |
| conditional | noop | 8 | 8 | 0 | null |
| conditional | prefix | 18 | 18 | 0 | null |
| conditional | revert-after-gold | 6 | 6 | 0 | null |
| conditional | oracle-with-reads | 8 | 0 | null | 0 |
| conditional | search-spam | 8 | 8 | 0 | null |
| conditional | sentinel-clobber | 8 | 8 | 0 | null |
| conditional | wrong-value | 8 | 8 | 0 | null |
| conditional | wrong-target | 8 | 8 | 0 | null |
| conditional | in-scope-clobber | 8 | 8 | 0.25 | null |
| conditional | write-then-revert | 8 | 0 | null | 1 |
| conditional | oracle-reordered | 2 | 0 | null | 0 |
| conditional | collection-spam | 6 | 6 | 0 | null |
| aggregation | oracle | 4 | 0 | null | 0 |
| aggregation | noop | 4 | 4 | 0 | null |
| aggregation | prefix | 8 | 8 | 0 | null |
| aggregation | revert-after-gold | 4 | 4 | 0 | null |
| aggregation | oracle-with-reads | 4 | 0 | null | 0 |
| aggregation | search-spam | 4 | 4 | 0 | null |
| aggregation | sentinel-clobber | 4 | 4 | 0 | null |
| aggregation | wrong-value | 4 | 4 | 0 | null |
| aggregation | wrong-target | 4 | 4 | 0 | null |
| aggregation | in-scope-clobber | 4 | 4 | 1 | null |
| aggregation | write-then-revert | 4 | 0 | null | 1 |

### Order-dependent tasks

- hard-api-derived-subject-close-09 · long-chain · holdout · reward 0.666666666667 · hard-api-derived-subject-close-09:oracle-reordered:1
- hard-api-derived-subject-close-10 · long-chain · holdout · reward 0.666666666667 · hard-api-derived-subject-close-10:oracle-reordered:1
- hard-api-derived-subject-close-11 · long-chain · holdout · reward 0.666666666667 · hard-api-derived-subject-close-11:oracle-reordered:1
- hard-api-derived-subject-close-12 · long-chain · holdout · reward 0.666666666667 · hard-api-derived-subject-close-12:oracle-reordered:1
- hard-api-reply-thread-close-09 · multi-hop · holdout · reward 0.5 · hard-api-reply-thread-close-09:oracle-reordered:1
- hard-api-reply-thread-close-10 · multi-hop · holdout · reward 0.5 · hard-api-reply-thread-close-10:oracle-reordered:1
- hard-api-reply-thread-close-11 · multi-hop · holdout · reward 0.5 · hard-api-reply-thread-close-11:oracle-reordered:1
- hard-api-reply-thread-close-12 · multi-hop · holdout · reward 0.5 · hard-api-reply-thread-close-12:oracle-reordered:1
- hard-api-ticket-resolve-notify-09 · multi-hop · holdout · reward 0.5 · hard-api-ticket-resolve-notify-09:oracle-reordered:1
- hard-api-ticket-resolve-notify-10 · multi-hop · holdout · reward 0.5 · hard-api-ticket-resolve-notify-10:oracle-reordered:1
- hard-api-ticket-resolve-notify-11 · multi-hop · holdout · reward 0.5 · hard-api-ticket-resolve-notify-11:oracle-reordered:1
- hard-api-ticket-resolve-notify-12 · multi-hop · holdout · reward 0.5 · hard-api-ticket-resolve-notify-12:oracle-reordered:1

Natural arm replay-fidelity mismatches: 0

Natural-arm rates are measured on recorded model trajectories, separately from the adversarial stress suite.
