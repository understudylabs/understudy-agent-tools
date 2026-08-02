# WL-AU repair-target memo

Workload code **WL-AU** (a design-partner "automation" workload: agentic,
multi-step business automation driven over a tool/API surface). Everything
below is an **aggregate** — counts, tokens, USD, distributions — computed from
gateway outer spans over 2026-06-03 → 2026-08-02. No prompts, completions,
payloads, request rows, or customer identifiers were exported, and none are
committed anywhere in this arm. Numbers as committed: `aggregates.json`.

## Is it worth repairing?

| Signal | Value | Reading |
| --- | --- | --- |
| Spend | **$8,395** over 60 days | #2 of 21 workloads in the project |
| Cost share | **26.8%** of project spend on **10.1%** of its requests | costs 2.7x its request share — an expensive-per-call workload |
| Volume | 92,177 requests; **66,833 in the last 14 days** | ramping, not decaying: a repair compounds |
| Repeatability | one endpoint, non-streaming, 76.1% of input served from prompt cache | a single stable task shape re-run at volume — the repairable pattern |
| Reliability | 0.98% errors, all upstream | nothing to fix on the correctness side of the gateway |
| Incumbents | two frontier models (57.3k + 33.9k requests) | no open-weight incumbent to beat; the replacement headroom is the full price gap |

Verdict: **suitable**, and near the top of the queue. High per-call cost, a
single repeated task shape, and rising volume are exactly the conditions where
a tuned small model pays back.

## Where the repair is safe — and where it is not

Output length splits the workload cleanly in two, and the split matters more
than the average:

| Slice | Requests | Share | Cost | Mean latency |
| --- | --- | --- | --- | --- |
| **Bounded** (≤512 output tokens) | 66,991 | 72.7% | $5,552 (66.1%) | 6.3s |
| Variable (>512) | 25,186 | 27.3% | $2,843 (33.9%) | 30.0s |

| Output band | Requests | Share | Cost |
| --- | --- | --- | --- |
| 0–128 | 18,118 | 19.7% | $1,202 |
| 129–512 | 48,873 | 53.0% | $4,350 |
| 513–1,024 | 9,880 | 10.7% | $968 |
| 1,025–2,048 | 4,967 | 5.4% | $638 |
| 2,049–4,096 | 10,005 | 10.9% | $1,187 |
| 4,097+ | 334 | 0.4% | $50 |

**Target the bounded slice.** Two thirds of the money sits in calls that emit
≤512 tokens: short, structured tool-call-shaped work. That dodges the known
variable-length failure mode — a small base can learn *which* call to make long
before it can learn *how many* calls to make, and length control is where
prompt-into-weights SFT on a small base has already been shown to collapse into
terminal-token repetition.

**Do not target the tail yet.** The variable slice is not merely long, it is
*truncated*: on the newer incumbent, **14.3% of requests emit exactly the
4,096-token cap** (p95 = p99 = max = 4,096), against 0.57% on the older one.
Those episodes end because they ran out of budget, not because they finished, so
their reference outputs are not clean supervision and their scores would measure
the cap rather than the policy. The 2,049–4,096 band is 10.9% of requests and
$1,187 — worth a separate arm with an explicit length/structure constraint, not
worth contaminating this one.

## Failing bands, in benchmark terms

The sanitized synthetic fixture (`automationbench-simple-api-offline-v2`) is the
stand-in for this task shape: bounded, one tool call per turn, graded on
terminal state. Against that fixture the base's weak bands are the multi-step
ones — `cross-record`, `long-chain`, `cascade` — while `single-write` and
`discovery` are close to solved. That is the same asymmetry the telemetry shows:
the short bounded majority is nearly free to serve correctly, and everything
expensive is a chain that has to be discovered in order.

So the repair objective for WL-AU is: **hold the bounded bands at parity, lift
the chained bands, and add zero forbidden writes.** A candidate that raises its
mean by acting more aggressively has not repaired anything — over-action is the
one failure this workload cannot absorb, because a write to a record the request
never addressed is a customer-visible defect rather than a lower score.

## Method note

Every number here is an aggregate over a telemetry table. Training and
evaluation for this arm use the synthetic fixture only; no trace, prompt,
completion, or identifier from the real workload enters the pairs, the model, or
this repository.
