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
| 2 | WL-02 | — | 83145 | 7638158651 | 61868504 | 0.793950 | 13877.288403 | 0.237531 | 0.010355 | pending — awaiting per-workload repair memo |
| 3 | WL-03 | — | 38048 | 1543989018 | 21036102 | 0.696463 | 4263.356460 | 0.072974 | 0.021552 | pending — awaiting per-workload repair memo |
| 4 | WL-04 | — | 39296 | 1412872736 | 18400589 | 0.793038 | 3011.857223 | 0.051552 | 0.027687 | pending — awaiting per-workload repair memo |
| 5 | WL-05 | WL-DI → [memo](../domain-identification-repair/REPAIR-MEMO.md) | 148936 | 675239846 | 9617187 | 0.664327 | 2447.093050 | 0.041886 | 0.000047 | memo landed — repair target; slice gates pass |
| 6 | WL-06 | — | 13545 | 773815738 | 4882849 | 0.827637 | 1337.175123 | 0.022888 | 0.018900 | pending — awaiting per-workload repair memo |
| 7 | WL-07 | — | 47872 | 158077276 | 8325019 | 0.007060 | 1002.539531 | 0.017160 | 0.234272 | pending — awaiting per-workload repair memo |
| 8 | WL-08 | WL-OR → [memo](../workload-orchestrator/repair-memo.md) | 2474 | 141267215 | 689926 | 0.079853 | 810.364917 | 0.013871 | 0.000808 | memo landed — repairable, second-wave; slice gates green |
| 9 | WL-09 | — | 7402 | 273138165 | 2917071 | 0.639952 | 791.761397 | 0.013552 | 0.042286 | pending — awaiting per-workload repair memo |
| 10 | WL-10 | WL-chat → [memo](../wl-chat-repair/repair-target-memo.md) | 2845 | 196153814 | 1007765 | 0.519242 | 659.769974 | 0.011293 | 0.004569 | memo landed — suitable repair target; fixture frozen/sealed |
| 11 | WL-11 | — | 14026 | 72162489 | 2905154 | 0.179329 | 386.563525 | 0.006617 | 0.000000 | pending — awaiting per-workload repair memo |
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
findings, and frozen-holdout refusal/opening checks passing. Its DPO result
remains pending.

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
- **Gate:** oracle/sentinel/leakage/frozen-holdout gates pass; DPO lift remains pending.

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

## DPO lift (base → DPO, dev/holdout per band)

Pending per-workload repair memos. Record base → DPO lift separately for each
dev and holdout band, preserving the band definition and sample count:

No DPO results have landed for WL-chat, WL-OR, or WL-DI. The base receipt at
`outputs/dpo/base-dev.json` is an offline fixture arm, not a DPO result:

| Base receipt band | Base mean | n | WL-chat DPO | WL-OR DPO | WL-DI DPO |
|---|---:|---:|---|---|---|
| aggregation | 1.000 | 2 | pending | pending | pending |
| cascade | 0.875 | 4 | pending | pending | pending |
| conditional | 1.000 | 4 | pending | pending | pending |
| cross-record | 0.833 | 6 | pending | pending | pending |
| discovery | 1.000 | 4 | pending | pending | pending |
| long-chain | 0.702 | 4 | pending | pending | pending |
| multi-hop | 0.500 | 4 | pending | pending | pending |
| multi-write | 0.750 | 4 | pending | pending | pending |
| single-write | 1.000 | 4 | pending | pending | pending |

## Does DPO lift correlate with volume/cost ranking?

Pending DPO measurements. Once the per-workload memos land, compare lift
against request volume, provider-equivalent token volume, cache-read share,
error rate, and spend rank. Report the relationship separately for dev and
holdout bands; do not infer correlation from spend rank alone.
