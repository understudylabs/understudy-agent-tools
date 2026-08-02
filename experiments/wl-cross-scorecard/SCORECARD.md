# Cross-workload repair scorecard

This scorecard tracks the synthetic-workload repair program across workloads.
It is an aggregate-only planning artifact: workload labels are neutral codes,
and no prompts, raw events, request identifiers, or private identifiers are
included.

## Ranked repair targets

Targets are ranked by 30-day combined customer and upstream USD. Provider-equivalent
input tokens are uncached input + cache-read input + cache-creation input.
Provider-equivalent output tokens are output tokens + reasoning output tokens.
Error rate is the share of events with `status_code >= 400`.

The 30-day combined total is **$58,423.14066701**. The all-time combined total
is **$62,683.08822989**.

| Rank | WL code | Arm label / memo | 30-day requests | Provider-equivalent input tokens | Provider-equivalent output tokens | Cache-read share | 30-day total USD | Share of total spend | Error rate | Benchmark gate status |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | WL-01 | — | 452221 | 9197098757 | 51067728 | 0.791192 | 28815.160985 | 0.493215 | 0.000038 | pending — awaiting per-workload repair memo |
| 2 | WL-02 | WL-AU → [README](../workload-automation/README.md) | 83145 | 7638158651 | 61868504 | 0.793950 | 13877.288403 | 0.237531 | 0.010355 | DPO landed — dev +0.019, 95% CI [-0.051, +0.090]; holdout comparison absent |
| 3 | WL-03 | — | 38048 | 1543989018 | 21036102 | 0.696463 | 4263.356460 | 0.072974 | 0.021552 | pending — awaiting per-workload repair memo |
| 4 | WL-04 | — | 39296 | 1412872736 | 18400589 | 0.793038 | 3011.857223 | 0.051552 | 0.027687 | pending — awaiting per-workload repair memo |
| 5 | WL-05 | WL-DI → [memo](../domain-identification-repair/REPAIR-MEMO.md) | 148936 | 675239846 | 9617187 | 0.664327 | 2447.093050 | 0.041886 | 0.000047 | DPO landed — dev +0.125, holdout +0.000; not promotable |
| 6 | WL-06 | WL-OEE → [memo](../on-event-execution/repair-memo.md) | 13545 | 773815738 | 4882849 | 0.827637 | 1337.175123 | 0.022888 | 0.018900 | DPO landed — dev +0.229; holdout clean and unexecuted |
| 7 | WL-07 | — | 47872 | 158077276 | 8325019 | 0.007060 | 1002.539531 | 0.017160 | 0.234272 | pending — awaiting per-workload repair memo |
| 8 | WL-08 | WL-OR → [memo](../workload-orchestrator/repair-memo.md) | 2474 | 141267215 | 689926 | 0.079853 | 810.364917 | 0.013871 | 0.000808 | DPO landed — dev +0.100, holdout +0.000; not promotable |
| 9 | WL-09 | — | 7402 | 273138165 | 2917071 | 0.639952 | 791.761397 | 0.013552 | 0.042286 | pending — awaiting per-workload repair memo |
| 10 | WL-10 | WL-chat → [memo](../wl-chat-repair/repair-target-memo.md) | 2845 | 196153814 | 1007765 | 0.519242 | 659.769974 | 0.011293 | 0.004569 | memo landed — suitable repair target; fixture frozen/sealed |
| 11 | WL-11 | WL-AOP → [README](../aop-selection-repair/README.md) | 14026 | 72162489 | 2905154 | 0.179329 | 386.563525 | 0.006617 | 0.000000 | DPO attempt landed — dev mixed by decode; holdout not run; do not promote |
| 12 | WL-12 | — | 15430 | 70990333 | 4921790 | 0.000000 | 382.397132 | 0.006545 | 0.000000 | pending — awaiting per-workload repair memo |
| 13 | WL-13 | — | 6188 | 70583743 | 4897776 | 0.000000 | 380.289973 | 0.006509 | 0.165966 | pending — awaiting per-workload repair memo |
| 14 | WL-14 | — | 12262 | 29297566 | 1216230 | 0.000000 | 141.514944 | 0.002422 | 0.000082 | pending — awaiting per-workload repair memo |
| 15 | WL-15 | — | 799 | 15344968 | 306746 | 0.037936 | 97.600984 | 0.001671 | 0.036295 | pending — awaiting per-workload repair memo |
| 16 | WL-16 | — | 366 | 12841042 | 160201 | 0.644411 | 14.671630 | 0.000251 | 0.013661 | pending — awaiting per-workload repair memo |
| 17 | WL-17 | — | 20 | 122446 | 92885 | 0.070251 | 1.478517 | 0.000025 | 0.000000 | pending — awaiting per-workload repair memo |
| 18 | WL-18 | — | 14 | 71237 | 179135 | 0.916153 | 1.383633 | 0.000024 | 0.000000 | pending — awaiting per-workload repair memo |
| 19 | WL-19 | — | 37 | 121101 | 26970 | 0.013716 | 0.735363 | 0.000013 | 0.000000 | pending — awaiting per-workload repair memo |
| 20 | WL-20 | — | 3 | 18694 | 9468 | 0.049642 | 0.103406 | 0.000002 | 0.000000 | pending — awaiting per-workload repair memo |
| 21 | WL-21 | — | 1 | 49 | 1715 | 0.000000 | 0.034496 | 0.000001 | 0.000000 | pending — awaiting per-workload repair memo |

## Benchmark gate status

Rows without landed artifacts remain **pending — awaiting per-workload repair
memo**. WL-chat has a landed memo and a frozen/sealed fixture gate: the freeze
artifact reports oracle mean/min 1.0, null max 0, no leakage failures, and
fail-closed holdout loading. Its DPO result remains pending. WL-OR has a landed
memo and green slice gates (oracle, activity, free-credit, leakage,
reachability, frozen-holdout refusal, and deterministic reset); it is
repairable but second-wave because the case is behavioural, not economic.
WL-DI has a landed memo and a passing gate-validation artifact: oracle 1.0 on
all 48 tasks with zero forbidden writes, sentinel maximum 0, zero leakage
findings, and frozen-holdout refusal/opening checks passing. Its DPO result is
now landed: dev improves from 0.625 to 0.750 (+0.125), while sealed holdout
remains 0.438 to 0.438 (+0.000); the result is not promotable. WL-OR's DPO result
is now landed: dev improves from 0.050 to
0.150 (+0.100), while sealed holdout remains 0.150 to 0.150 (+0.000). The
memo's verdict is **not promotable**: the gain does not survive the seal, while
over-acting and forbidden writes fall to zero and malformed-emission rate stays
at 1.00. WL-AOP has a passing 60-task gate fixture and a landed DPO attempt:
greedy dev falls from 0.917 to 0.667 (-0.250), while sampled dev rises from
0.729 to 0.771 (+0.042). Its holdout was structurally excluded and never run,
so the attempt is **do not promote**, not a sealed-holdout result.
WL-AU has a passing 216-task gate fixture and a landed DPO attempt: sampled dev
improves from 0.8030 to 0.8219 (+0.019), but the 95% interval is
[-0.051, +0.090] with 11 wins and 11 losses. Its candidate was never scored on
the holdout, so the base-only reference is not a holdout comparison; the result
is a null/no-promotion outcome.
WL-OEE has a passing 96-task gate fixture and a landed DPO result: dev improves
from 0.425 to 0.654 (+0.229) across 16 tasks, with zero over-acting and
forbidden writes in both arms. Its holdout is clean and unexecuted, so there is
no unseen-split confirmation of the dev direction.

## Landed memo summaries

### WL-chat — suitable repair target

- **Memo:** [repair-target-memo.md](../wl-chat-repair/repair-target-memo.md)
- **Volume/cost:** 3,488 requests; **$422.16**; **$0.121/request**.
- **Input:** 104.4M uncached + 119.6M cache-read + 20.2M cache-create tokens.
- **Output:** 1.21M tokens; p50 192; p95 1,062.
- **Bounded-output bands:** ≤64: 5.7%; 65–256: 56.5%; 257–1,024: 32.6%; >1,024: 5.3%.
- **Reliability:** 99.5% success; 16 HTTP 400 and 2 HTTP 502 errors.
- **Verdict:** suitable repair target; uniform single-shot shape and bounded output.
- **Failing bands:** >1,024-token long-context tail; ≤64-token refusal/fabrication band.
- **Gate:** fixture frozen/sealed; DPO lift and regression results pending.

### WL-DI — repair target

- **Memo:** [REPAIR-MEMO.md](../domain-identification-repair/REPAIR-MEMO.md)
- **Volume/cost:** 149,577 requests over 37 days; **$1,228.33**; **$0.00821/request**.
- **Input:** 227.8M uncached + 449.9M cache-read tokens; cache-read share 66.39%.
- **Output:** p50 74, p95 114, p99 130, max 2,555; 99.85% ≤150 tokens.
- **Output bands:** <40: 39.43%; 40–79: 15.98%; 80–119: 42.14%; 120–159: 2.33%; ≥160: 0.11%.
- **Reliability:** 100% success aggregate; 7 upstream errors and no fallbacks.
- **Verdict:** repair; high-volume, repeatable, bounded output, and cost-effective in aggregate.
- **Candidate gap:** open-model arm averaged 341 output tokens; only 20.2% stayed within ≤150.
- **Failing bands:** short terse decisions and 80–119-token justifications both need preservation; ≥160 is the tail.
- **Gate:** oracle/sentinel/leakage/frozen-holdout gates pass; DPO is not promotable.
- **DPO:** dev +0.125 overall; sealed holdout +0.000; over-acting and forbidden writes remain zero.

### WL-OR — repairable, second-wave

- **Memo:** [repair-memo.md](../workload-orchestrator/repair-memo.md)
- **Volume/cost:** 2,481 requests; **$406.49**; **$0.164/request**.
- **Input:** 128.4M uncached + 11.3M cache-read + 2.0M cache-create tokens.
- **Output:** p50 202; p95 698; max 2,095; CV 0.79; 98.8% ≤1,024 tokens.
- **Reliability:** 99.9% success; 2 upstream errors.
- **Verdict:** repairable, second-wave (**behavioural not economic**).
- **Slice gate:** green; 30 tasks with inherited train/dev/holdout splits.
- **Failing bands:** multi-write base mean 0.063 (n=4); single-write 0.000 (n=1).
- **Failure modes:** malformed emission discipline, over-action/write scoping, chain completion.
- **DPO:** dev +0.100 overall; sealed holdout +0.000; not promotable.

### WL-AOP — good target, small prize

- **Arm:** [README](../aop-selection-repair/README.md); workload label WL-AOP.
- **Volume/cost:** 14,027 requests in 30d; **$193.29**; **$13.78 per 1k requests**.
- **Share:** 1.54% of requests; 0.62% of aggregate cost.
- **Input:** p50 3,694 and p95 11,397 tokens; 17.9% cache-read.
- **Output:** p50 217, p95 253, p99 265, max 346; p95/p50 ratio 1.17.
- **Reliability:** 100% success; 0 non-200 requests; non-streaming.
- **Verdict:** good repair/method target but a small savings prize; do not promote the DPO attempt.
- **Failing bands:** direct and disambiguation selection; restraint is comparatively strong.
- **Gate:** oracle 1.0 on all 60 tasks, sentinel 0.0, leakage/reachability/reset checks pass, and frozen-holdout refusal passes.
- **DPO:** 184 train-only pairs; 126 malformed-emission versus 58 different-action pairs; holdout was never executed.

### WL-AU — high-spend, variable-length repair target

- **Arm:** [README](../workload-automation/README.md); workload label WL-AU.
- **Volume/cost:** 92,177 requests over 60 days; **$8,395.01**; rank 2 by project cost.
- **Share:** 10.1% of project requests; 26.8% of project cost.
- **Input:** 1.15B uncached + 6.39B cache-read + 0.87B cache-create tokens; 76.1% cache-read.
- **Output:** 72.7% ≤512 tokens, but p95 reaches 4,096; the remaining tail is variable-length.
- **Reliability:** 99.0% aggregate success; 908 upstream errors; non-streaming.
- **Verdict:** worth repairing, but this DPO attempt is a null result and should not be promoted.
- **Failing bands:** malformed emissions dominate; chained bands and multi-write/aggregation cells move inconsistently.
- **Gate:** oracle 1.000, sentinel 0.000, leakage clean, unreachable literals absent, deterministic reset and frozen-holdout refusal pass.
- **DPO:** 126 train-only pairs; sampled dev +0.019 with CI spanning zero; holdout candidate was never scored.

### WL-OEE — suitable methodology target

- **Arm:** [repair-memo.md](../on-event-execution/repair-memo.md); workload label WL-OEE.
- **Volume/cost:** 13,912 requests over 30 active days; **$703.79**; **$0.0506/request**.
- **Rank/share:** rank 6 by cost; 2.24% of aggregate project spend.
- **Input:** 794.3M provider-equivalent tokens; p50 55,434, p95 89,237; 82.1% cache-read.
- **Output:** p50 192, p95 1,099; 66.6% below 256 tokens; bounded majority with a variable tail.
- **Reliability:** 98.2% success aggregate; 256 upstream non-success requests.
- **Verdict:** suitable methodology target; context-bound economics make replacement quality the key question.
- **Failing bands:** malformed tool calls dominate; requester→contact joins are difficult in the bounded band; variable tail remains unmeasured.
- **Gate:** oracle 1.0, sentinel 0.0, leakage/reachability/determinism/integrity checks pass; frozen-holdout refusal passes.
- **DPO:** 42 train-only pairs; dev +0.229 on 16 tasks; holdout clean and deliberately unexecuted.

## DPO lift (base → DPO, dev/holdout per band)

WL-OR and WL-DI have complete base-to-DPO comparisons. WL-AOP has a DPO
attempt with dev results under two decode settings, but its sealed holdout was
structurally absent from the submit payload and never executed. Values below
come from the dev and sealed-holdout band reports; `n` is the task count per band.
WL-AU has sampled dev band results, but no candidate holdout run; its base-only
holdout reference is not a lift measurement. WL-OEE has a clean, unexecuted
holdout and dev-only per-band results. WL-chat DPO results remain pending.

| WL-OR band | n | Dev base | Dev DPO | Dev Δ | Holdout base | Holdout DPO | Holdout Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| multi-write | 4 | 0.063 | 0.188 | **+0.125** | 0.188 | 0.188 | 0.000 |
| single-write | 1 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| **all** | **5** | **0.050** | **0.150** | **+0.100** | **0.150** | **0.150** | **0.000** |

The run is **not promotable**. The candidate removes over-acting and forbidden
writes (2/2 on dev base to 0/0, and 0/0 retained on holdout), but malformed
emissions remain 5/5 in both arms and both splits. The generic
`outputs/dpo/base-dev.json` receipt remains a separate offline fixture and is
not substituted for these WL-OR measurements.

### WL-DI DPO result

| WL-DI band | Dev n | Dev base | Dev DPO | Dev Δ | Holdout n | Holdout base | Holdout DPO | Holdout Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| abstain | 2 | 0.000 | 0.500 | **+0.500** | 4 | 0.250 | 0.000 | -0.250 |
| direct-match | 2 | 1.000 | 0.500 | **-0.500** | 4 | 0.750 | 0.500 | -0.250 |
| near-match | 2 | 1.000 | 1.000 | 0.000 | 4 | 0.500 | 0.750 | **+0.250** |
| parent-join | 2 | 0.500 | 1.000 | **+0.500** | 4 | 0.250 | 0.500 | **+0.250** |
| **all** | **8** | **0.625** | **0.750** | **+0.125** | **16** | **0.438** | **0.438** | **+0.000** |

The dev movement is a redistribution across bands, and the 22 accepted pairs
cover only 6 of 24 train tasks; 14/22 pairs come from `abstain` (64%). Both
arms retain zero over-acting and forbidden writes on dev and holdout. The run
is **not promotable**.

### WL-AOP DPO attempt

No sealed-holdout base or DPO result exists for this arm: the holdout was
structurally excluded from the submission and never executed. The following
are dev-only reports, each over 12 tasks (4 per band).

| Decode | WL-AOP band | Dev n | Base | DPO | Δ | Holdout |
|---|---|---:|---:|---:|---:|---|
| greedy (T=0) | direct | 4 | 0.750 | 0.750 | 0.000 | not run |
| greedy (T=0) | disambiguation | 4 | 1.000 | 0.500 | **-0.500** | not run |
| greedy (T=0) | restraint | 4 | 1.000 | 0.750 | **-0.250** | not run |
| greedy (T=0) | **all** | **12** | **0.917** | **0.667** | **-0.250** | not run |
| sampled (T=1, 4 samples) | direct | 4 | 0.563 | 0.625 | **+0.063** | not run |
| sampled (T=1, 4 samples) | disambiguation | 4 | 0.875 | 0.938 | **+0.063** | not run |
| sampled (T=1, 4 samples) | restraint | 4 | 0.750 | 0.750 | 0.000 | not run |
| sampled (T=1, 4 samples) | **all** | **12** | **0.729** | **0.771** | **+0.042** | not run |

The attempt is **do not promote**: the sampled gain is small on a 12-task
split, while the same candidate is materially worse under greedy decoding.
Over-acting and forbidden writes remain zero in both reports; malformed
emissions remain 12/12 in both arms and settings.

### WL-AU DPO result

The primary protocol is sampled dev evaluation (T=0.7, four samples per task).
There is no candidate holdout result: the base was read once on 60 holdout
episodes before the stop directive, but the candidate was never scored.

| WL-AU band | Dev n | Base | DPO | Dev Δ | Holdout |
|---|---:|---:|---:|---:|---|
| single-write | 4 | 0.750 | 1.000 | **+0.250** | not run |
| discovery | 4 | 0.875 | 0.875 | 0.000 | not run |
| multi-write | 4 | 0.802 | 0.719 | **-0.083** | not run |
| cross-record | 6 | 0.875 | 0.896 | **+0.021** | not run |
| multi-hop | 4 | 0.531 | 0.625 | **+0.094** | not run |
| cascade | 4 | 0.953 | 0.812 | **-0.141** | not run |
| long-chain | 4 | 0.565 | 0.679 | **+0.113** | not run |
| conditional | 4 | 0.938 | 0.969 | **+0.031** | not run |
| aggregation | 2 | 1.000 | 0.750 | **-0.250** | not run |
| **all** | **36** | **0.803** | **0.822** | **+0.019** | not run |

The paired 95% CI is **[-0.051, +0.090]**, with 11 wins, 11 losses, and 14
ties; the effect is not distinguishable from zero. Over-acting remained zero
in both arms and forbidden effects fell from 5 to 3, but these small-count
guardrail changes do not establish a quality win. The arm is **not promotable**.

### WL-OEE DPO result

The dev comparison used the same renderer and temperature-0 sampling for both
arms. The holdout is clean and was never executed; no holdout base or candidate
scores are reported.

| WL-OEE band | Dev n | Base | DPO | Dev Δ | Holdout |
|---|---:|---:|---:|---:|---|
| bounded | 10 | 0.400 | 0.667 | **+0.267** | clean, not run |
| extended | 4 | 0.500 | 0.750 | **+0.250** | clean, not run |
| variable | 2 | 0.400 | 0.400 | 0.000 | clean, not run |
| **overall** | **16** | **0.425** | **0.654** | **+0.229** | clean, not run |

Over-acting and forbidden writes remained zero in both arms; malformed episodes
fell from 16/16 to 15/16. The variable band did not move and has only two dev
tasks, so the result is directional rather than a production or holdout claim.

## Does DPO lift correlate with volume/cost ranking?

**Partial — five DPO arms are now available, but only two have clean sealed
holdout results.** WL-OR (rank 8 by spend)
shows +0.100 dev lift and +0.000 sealed-holdout lift; WL-DI (rank 5) shows
+0.125 dev lift and +0.000 sealed-holdout lift. Both are behavioural cases and
both are **not promotable**. WL-AOP (rank 11) has no sealed-holdout result:
greedy dev is -0.250, while sampled dev is +0.042 and is explicitly not
promotable. WL-AU (rank 2) has +0.019 sampled dev lift with a 95% CI of
[-0.051, +0.090], so its high-spend result is also consistent with no lift;
its candidate holdout was never run. This strengthens the emerging read that
DPO lift does **not** track spend rank, but it does not create a holdout result
or a statistically established correlation. WL-OEE (rank 6) adds +0.229 dev
lift, but its clean holdout was deliberately unexecuted and its 16-task dev
split is too small for a firm effect claim. Pair coverage/data volume per
failing band remains the more plausible binding constraint. The evidence is
also decode- and split-sensitive. A high-spend arm with genuine sealed-holdout
lift would falsify this pattern; so would more arms with varied spend ranks,
adequate per-band coverage, and replicated holdout outcomes.
