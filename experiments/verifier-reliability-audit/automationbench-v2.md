## Verifier reliability audit — automationbench-v2

An RL/DPO lift may only be believed on bands whose verdict is `trusted`.
Untrusted bands need reward shaping or a process reward before reporting a lift.
FP/FN rates are conditional on this adversarial suite composition; they are stress-test measures, not estimates over a natural policy distribution.

| Band | Probes | FP rate | FN rate | MCC | Max true-failure reward | Disagreements | Verdict |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| single-write | 225 | 0.090909090909 | 0.333333333333 | 0.592449657765 | 1 | 0 | untrusted |
| discovery | 210 | 0.066666666667 | 0.333333333333 | 0.636396103068 | 1 | 0 | untrusted |
| multi-write | 255 | 0.111111111111 | 0.266666666667 | 0.622222222222 | 1 | 0 | untrusted |
| cross-record | 312 | 0.035714285714 | 0.272727272727 | 0.738622210987 | 1 | 0 | insufficient-evidence |
| multi-hop | 232 | 0.086956521739 | 0.333333333333 | 0.579710144928 | 1 | 0 | insufficient-evidence |
| cascade | 272 | 0.076923076923 | 0.25 | 0.673076923077 | 1 | 0 | insufficient-evidence |
| long-chain | 264 | 0.076923076923 | 0.285714285714 | 0.637362637363 | 1 | 0 | insufficient-evidence |
| conditional | 208 | 0.025641025641 | 0.307692307692 | 0.732467020765 | 1 | 0 | insufficient-evidence |
| aggregation | 96 | 0.111111111111 | 0.333333333333 | 0.555555555556 | 1 | 0 | insufficient-evidence |

### Probe-family decomposition

| Band | Family | Probes | True failures | FP rate | FN rate |
| --- | --- | ---: | ---: | ---: | ---: |
| single-write | oracle | 20 | 0 | null | 0 |
| single-write | noop | 20 | 20 | 0 | null |
| single-write | prefix | 25 | 25 | 0 | null |
| single-write | revert-after-gold | 20 | 20 | 0 | null |
| single-write | oracle-with-reads | 20 | 0 | null | 0 |
| single-write | search-spam | 20 | 20 | 0 | null |
| single-write | sentinel-clobber | 20 | 20 | 0 | null |
| single-write | wrong-value | 20 | 20 | 0 | null |
| single-write | wrong-target | 20 | 20 | 0 | null |
| single-write | in-scope-clobber | 20 | 20 | 0.75 | null |
| single-write | write-then-revert | 20 | 0 | null | 1 |
| discovery | oracle | 20 | 0 | null | 0 |
| discovery | noop | 20 | 20 | 0 | null |
| discovery | prefix | 20 | 20 | 0 | null |
| discovery | oracle-with-reads | 20 | 0 | null | 0 |
| discovery | search-spam | 20 | 20 | 0 | null |
| discovery | sentinel-clobber | 20 | 20 | 0 | null |
| discovery | wrong-value | 20 | 20 | 0 | null |
| discovery | collection-spam | 20 | 20 | 0.25 | null |
| discovery | write-then-revert | 20 | 0 | null | 1 |
| discovery | revert-after-gold | 10 | 10 | 0 | null |
| discovery | wrong-target | 10 | 10 | 0 | null |
| discovery | in-scope-clobber | 10 | 10 | 0.5 | null |
| multi-write | oracle | 20 | 0 | null | 0 |
| multi-write | noop | 20 | 20 | 0 | null |
| multi-write | prefix | 40 | 40 | 0 | null |
| multi-write | revert-after-gold | 10 | 10 | 0 | null |
| multi-write | oracle-with-reads | 20 | 0 | null | 0 |
| multi-write | oracle-reordered | 15 | 0 | null | 0 |
| multi-write | search-spam | 20 | 20 | 0 | null |
| multi-write | sentinel-clobber | 20 | 20 | 0 | null |
| multi-write | wrong-value | 20 | 20 | 0 | null |
| multi-write | wrong-target | 20 | 20 | 0 | null |
| multi-write | in-scope-clobber | 20 | 20 | 0.75 | null |
| multi-write | write-then-revert | 20 | 0 | null | 1 |
| multi-write | collection-spam | 10 | 10 | 0.5 | null |
| cross-record | oracle | 24 | 0 | null | 0 |
| cross-record | noop | 24 | 24 | 0 | null |
| cross-record | prefix | 56 | 56 | 0 | null |
| cross-record | revert-after-gold | 24 | 24 | 0 | null |
| cross-record | oracle-with-reads | 24 | 0 | null | 0 |
| cross-record | search-spam | 24 | 24 | 0 | null |
| cross-record | sentinel-clobber | 24 | 24 | 0 | null |
| cross-record | wrong-value | 24 | 24 | 0 | null |
| cross-record | wrong-target | 24 | 24 | 0 | null |
| cross-record | in-scope-clobber | 24 | 24 | 0.333333333333 | null |
| cross-record | write-then-revert | 24 | 0 | null | 1 |
| cross-record | oracle-reordered | 16 | 0 | null | 0 |
| multi-hop | oracle | 16 | 0 | null | 0 |
| multi-hop | noop | 16 | 16 | 0 | null |
| multi-hop | prefix | 56 | 56 | 0 | null |
| multi-hop | oracle-with-reads | 16 | 0 | null | 0 |
| multi-hop | oracle-reordered | 16 | 16 | 0 | null |
| multi-hop | search-spam | 16 | 16 | 0 | null |
| multi-hop | sentinel-clobber | 16 | 16 | 0 | null |
| multi-hop | wrong-value | 16 | 16 | 0 | null |
| multi-hop | wrong-target | 16 | 16 | 0 | null |
| multi-hop | in-scope-clobber | 16 | 16 | 1 | null |
| multi-hop | collection-spam | 16 | 16 | 0 | null |
| multi-hop | write-then-revert | 16 | 0 | null | 1 |
| cascade | oracle | 16 | 0 | null | 0 |
| cascade | noop | 16 | 16 | 0 | null |
| cascade | prefix | 88 | 88 | 0 | null |
| cascade | revert-after-gold | 16 | 16 | 0 | null |
| cascade | oracle-with-reads | 16 | 0 | null | 0 |
| cascade | oracle-reordered | 16 | 0 | null | 0 |
| cascade | search-spam | 16 | 16 | 0 | null |
| cascade | sentinel-clobber | 16 | 16 | 0 | null |
| cascade | wrong-value | 16 | 16 | 0 | null |
| cascade | wrong-target | 16 | 16 | 0 | null |
| cascade | in-scope-clobber | 16 | 16 | 1 | null |
| cascade | collection-spam | 8 | 8 | 0 | null |
| cascade | write-then-revert | 16 | 0 | null | 1 |
| long-chain | oracle | 16 | 0 | null | 0 |
| long-chain | noop | 16 | 16 | 0 | null |
| long-chain | prefix | 88 | 88 | 0 | null |
| long-chain | oracle-with-reads | 16 | 0 | null | 0 |
| long-chain | oracle-reordered | 16 | 8 | 0 | 0 |
| long-chain | search-spam | 16 | 16 | 0 | null |
| long-chain | sentinel-clobber | 16 | 16 | 0 | null |
| long-chain | wrong-value | 16 | 16 | 0 | null |
| long-chain | wrong-target | 16 | 16 | 0 | null |
| long-chain | in-scope-clobber | 16 | 16 | 1 | null |
| long-chain | collection-spam | 16 | 16 | 0 | null |
| long-chain | write-then-revert | 16 | 0 | null | 1 |
| conditional | oracle | 16 | 0 | null | 0 |
| conditional | noop | 16 | 16 | 0 | null |
| conditional | prefix | 36 | 36 | 0 | null |
| conditional | revert-after-gold | 12 | 12 | 0 | null |
| conditional | oracle-with-reads | 16 | 0 | null | 0 |
| conditional | search-spam | 16 | 16 | 0 | null |
| conditional | sentinel-clobber | 16 | 16 | 0 | null |
| conditional | wrong-value | 16 | 16 | 0 | null |
| conditional | wrong-target | 16 | 16 | 0 | null |
| conditional | in-scope-clobber | 16 | 16 | 0.25 | null |
| conditional | write-then-revert | 16 | 0 | null | 1 |
| conditional | oracle-reordered | 4 | 0 | null | 0 |
| conditional | collection-spam | 12 | 12 | 0 | null |
| aggregation | oracle | 8 | 0 | null | 0 |
| aggregation | noop | 8 | 8 | 0 | null |
| aggregation | prefix | 16 | 16 | 0 | null |
| aggregation | revert-after-gold | 8 | 8 | 0 | null |
| aggregation | oracle-with-reads | 8 | 0 | null | 0 |
| aggregation | search-spam | 8 | 8 | 0 | null |
| aggregation | sentinel-clobber | 8 | 8 | 0 | null |
| aggregation | wrong-value | 8 | 8 | 0 | null |
| aggregation | wrong-target | 8 | 8 | 0 | null |
| aggregation | in-scope-clobber | 8 | 8 | 1 | null |
| aggregation | write-then-revert | 8 | 0 | null | 1 |

### Order-dependent tasks

- hard-api-derived-subject-close-01 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-01:oracle-reordered:1
- hard-api-derived-subject-close-02 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-02:oracle-reordered:1
- hard-api-derived-subject-close-03 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-03:oracle-reordered:1
- hard-api-derived-subject-close-04 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-04:oracle-reordered:1
- hard-api-derived-subject-close-05 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-05:oracle-reordered:1
- hard-api-derived-subject-close-06 · long-chain · train · reward 0.666666666667 · hard-api-derived-subject-close-06:oracle-reordered:1
- hard-api-derived-subject-close-07 · long-chain · dev · reward 0.666666666667 · hard-api-derived-subject-close-07:oracle-reordered:1
- hard-api-derived-subject-close-08 · long-chain · dev · reward 0.666666666667 · hard-api-derived-subject-close-08:oracle-reordered:1
- hard-api-reply-thread-close-01 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-01:oracle-reordered:1
- hard-api-reply-thread-close-02 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-02:oracle-reordered:1
- hard-api-reply-thread-close-03 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-03:oracle-reordered:1
- hard-api-reply-thread-close-04 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-04:oracle-reordered:1
- hard-api-reply-thread-close-05 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-05:oracle-reordered:1
- hard-api-reply-thread-close-06 · multi-hop · train · reward 0.5 · hard-api-reply-thread-close-06:oracle-reordered:1
- hard-api-reply-thread-close-07 · multi-hop · dev · reward 0.5 · hard-api-reply-thread-close-07:oracle-reordered:1
- hard-api-reply-thread-close-08 · multi-hop · dev · reward 0.5 · hard-api-reply-thread-close-08:oracle-reordered:1
- hard-api-ticket-resolve-notify-01 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-01:oracle-reordered:1
- hard-api-ticket-resolve-notify-02 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-02:oracle-reordered:1
- hard-api-ticket-resolve-notify-03 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-03:oracle-reordered:1
- hard-api-ticket-resolve-notify-04 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-04:oracle-reordered:1
- hard-api-ticket-resolve-notify-05 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-05:oracle-reordered:1
- hard-api-ticket-resolve-notify-06 · multi-hop · train · reward 0.5 · hard-api-ticket-resolve-notify-06:oracle-reordered:1
- hard-api-ticket-resolve-notify-07 · multi-hop · dev · reward 0.5 · hard-api-ticket-resolve-notify-07:oracle-reordered:1
- hard-api-ticket-resolve-notify-08 · multi-hop · dev · reward 0.5 · hard-api-ticket-resolve-notify-08:oracle-reordered:1

Natural arm replay-fidelity mismatches: 0

Natural-arm rates are measured on recorded model trajectories, separately from the adversarial stress suite.
