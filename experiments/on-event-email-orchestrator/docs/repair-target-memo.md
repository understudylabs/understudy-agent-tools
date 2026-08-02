# Repair-target memo — `on-event-email-orchestrator` (WL-07)

Aggregates only. No raw requests, responses, prompts, tenant identifiers, or
per-record rows are reproduced here or anywhere else in this directory; every
number below is a count, a token sum, a dollar sum, or a distribution quantile
computed over gateway telemetry. The benchmark work in this directory is built
from **sanitized synthetic fixtures** and never reads production payloads.

## Verdict

**Repair it.** WL-07 is the single largest cost line in its project, it is
overwhelmingly one model on one shape, and — the part that actually decides
this — **its output is bounded**. 98.4% of episodes emit ≤ 256 output tokens
(p50 106, p95 175). That sidesteps the failure mode that has sunk small-base
attempts on the sibling orchestrator shapes, where variable-length tool-call
generation collapsed into terminal-token repetition loops. Here the policy has
to make a short, structured, event-triggered decision, which is the shape a
tuned small model is actually good at.

## Volume and cost

Window: first observed 2026-06-03 through 2026-08-02, gateway outer spans.

| Metric | Value |
| --- | --- |
| requests | 470,398 |
| customer cost | $14,898.30 |
| share of project customer cost | 47.5% (project total $31,382.71 over 915,296 requests) |
| rank within project | 1 of 21 workloads, by cost and by requests |
| uncached input tokens | 1,971,821,705 |
| cache-read input tokens | 7,553,458,112 |
| cache-creation input tokens | 0 |
| output tokens (incl. reasoning) | 53,614,674 |
| cache-read share of provider-equivalent input | 79.3% |
| mean cost / request (last 30d) | $0.0319 |

Trailing 30 days: 452,221 requests, $14,407.58, 9.197B input tokens, 51.07M
output tokens — i.e. essentially all of the lifetime volume is recent.

Run rate is bursty, so both numbers matter:

| Period | Requests | Cost |
| --- | --- | --- |
| peak day (2026-07-23) | 26,841 | $851.99 |
| peak week (w/c 2026-07-12) | 180,404 | $6,012.83 |
| recent steady state (2026-07-27 → 2026-07-31) | ~5.0k–6.9k / day | ~$120–$166 / day |

At the recent steady state the workload is a ~$4.5k/month line; at the July
peak it was a ~$25k/month line. Either way it is the top line in the project.

## Traffic composition

| Provider | Served model | Requests | Cost | Mean output tok | p50 / p95 / p99 output tok |
| --- | --- | --- | --- | --- | --- |
| incumbent A | frontier general-purpose model | 469,816 | $14,887.76 | 113.7 | 106 / 175 / 278 |
| open-weight trial | large open-weight MoE | 582 | $10.54 | 353.6 | 194 / 1,292 / 1,875 |

99.88% of episodes and 99.93% of spend sit on a single incumbent model, so a
single replacement candidate covers effectively the whole workload. A small
open-weight trial slice already exists, and it is a useful warning rather than
a baseline: its output length distribution is 7x wider at p95, which is exactly
the length-control regression a tuned candidate has to be gated against.

Reliability is not the problem — 470,372 of 470,398 episodes returned 200; all
26 failures were upstream errors (400/500/502/503/520/431). This is a cost and
ownership repair, not an incident.

## Shape (why it is repairable)

| Property | Value | Why it matters |
| --- | --- | --- |
| calls per episode | 1 gateway call, 0 inner calls, non-streaming | Single-shot decision, not an open-ended agent loop |
| input size | p50 20,415 / p95 30,712 provider-equivalent tokens | Large fixed instruction + event context, 79.3% cache-read → the context is near-identical episode to episode, i.e. highly repeatable |
| output size | p50 106 / p95 175 / max 16,384 | **Bounded.** The long tail is 0.14% of episodes |
| latency | p50 1,661 ms / p95 5,623 ms | Interactive-adjacent; a small model is a latency win too |

Output-length bands:

| Output tokens | Episodes | Share | Cost |
| --- | --- | --- | --- |
| 0–64 | 29,591 | 6.29% | $764.06 |
| 65–128 | 383,790 | 81.59% | $12,037.83 |
| 129–256 | 49,358 | 10.49% | $1,762.87 |
| 257–512 | 6,687 | 1.42% | $264.79 |
| 513–1024 | 335 | 0.07% | $13.73 |
| 1024+ | 637 | 0.14% | $55.02 |

Bounded-vs-variable: **98.37% bounded (≤ 256 output tokens), 1.63% variable.**
The bounded mass also carries 98.4% of the spend, so a candidate that only ever
handles bounded episodes still addresses essentially the whole bill; the 1.63%
variable tail is a natural escalate-to-incumbent carve-out rather than
something the tuned policy has to win.

The 79.3% cache-read share is the second repeatability signal: the same
instruction block is being re-sent hundreds of thousands of times against a
small, varying event payload. That is the definition of a specialist task being
run on a generalist model.

## Repair suitability scorecard

| Criterion | Assessment |
| --- | --- |
| Volume | 470k episodes, ~5–7k/day steady state — ample for training and for statistically meaningful eval |
| Cost | $14.9k observed, top line in the project at 47.5% of spend |
| Repeatability | 79.3% cache-read input share; one model, one endpoint shape, one decision per episode |
| Output boundedness | 98.4% ≤ 256 tokens — dodges the variable-length repetition-loop failure mode |
| Failure risk | Over-acting (writing records the event never addressed) rather than length collapse; directly gateable |
| Verdict | **Strong repair target** |

## Failing bands and what the benchmark must gate

Production telemetry carries no per-episode correctness label, so band-level
failure is measured on the synthetic slice in this directory
(`wl07-email-orchestration-offline-v1`), not inferred from traffic. Two bands
carry the risk that the aggregates above imply:

1. **Over-acting / forbidden writes.** The episode is one shot with a small
   addressed set of records. A policy that writes a neighbouring record scores
   zero on the outcome contract regardless of how good its text is. The slice
   therefore includes a conditional-no-op family with decoy records, and
   `allowedWrites` is exactly the addressed set.
2. **Length / structure control.** The open-weight trial slice above shows a
   candidate can pass on intent while blowing up the output distribution. Any
   candidate is reported per band with over-acting episodes and forbidden
   writes as raw counts alongside its mean score, and a candidate that adds
   forbidden writes is not a win.

## Query provenance

Gateway telemetry, outer spans only, scoped to a single project; costs joined
per event from the cost table; workload names resolved from the current
workload dimension. Provider-equivalent input = uncached input + cache-read +
cache-creation; provider-equivalent output = output + reasoning output. No
payload bodies, capture envelopes, or identifiers were read.
