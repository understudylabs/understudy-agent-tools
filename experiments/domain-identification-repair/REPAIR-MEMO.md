# Repair memo — workload `domain-identification` (WL-DI)

Aggregates only. Every number here is a count, a token total, a USD total, or a
quantile computed in the warehouse; no prompt, completion, request id, tenant id,
or raw row was read into this repository. Machine-readable copy:
[`aggregates.json`](aggregates.json).

Window: 2026-06-26 → 2026-08-02 (37 days).

## Is it worth repairing?

| Signal | Value | Read |
| --- | --- | --- |
| Requests | 149,577 | 2nd-highest-volume workload in the project (16.4% of all requests) |
| Spend | $1,228 in 37 days (~$1,000/month run-rate, rising) | 5th by cost — cheap *per call*, expensive *in aggregate* |
| Unit cost | $8.21 per 1,000 requests | the whole saving is unit-cost × volume, not a few heavy calls |
| Output length | p50 74, p95 114, p99 130 tokens | **bounded** |
| ≤150 output tokens | 99.85% of calls | bounded envelope is a property of the task, not of a prompt trick |
| Input length | p50 3,948, p95 7,886 tokens; 66.4% served from cache read | one stable instruction block, small per-call payload |
| Reliability | 100% success; 7 upstream errors total; 0 fallbacks | no reliability fire to fight — this is purely a cost/ownership repair |
| Trend | 66,016 requests / $509 in the most recent full week | growing, so the repair compounds |

**Verdict: repair.** High repeatability (a single stable instruction block, 66%
cache-read share), high volume, and a bounded output envelope. Bounded output is
the decisive property: the recorded failure mode for prompt-into-weights work on
small bases is *sequence-length control* on variable-length generation, and this
workload never asks for a variable-length sequence — p99 is 130 tokens and the
task emits one short decision per call. That dodges the failure mode instead of
walking into it.

The workload also splits cleanly by output length, which is what a per-band
report needs:

| Band (output tokens) | Requests | Share | Mean out | Cost |
| --- | ---: | ---: | ---: | ---: |
| < 40 | 58,980 | 39.4% | 26.1 | $491.67 |
| 40–79 | 23,903 | 16.0% | 66.0 | $181.41 |
| 80–119 | 63,036 | 42.1% | 96.2 | $524.24 |
| 120–159 | 3,488 | 2.3% | 127.3 | $29.15 |
| ≥ 160 | 166 | 0.1% | 202.7 | $1.83 |

Two modes dominate: a terse decision (<40 tokens, 39%) and a decision carrying a
short justification (80–119 tokens, 42%). A candidate has to hold **both** — a
model that always writes the long form burns the margin, and a model that always
writes the short form drops the justification the long band exists for.

## Where the failing band is

A small open-weight arm already ran against this workload on the same requested
model (302 requests). Its completions averaged 341 output tokens and only 20.2%
landed inside the incumbent's ≤150-token envelope, against 99.85% for the
incumbent. The visible open-model gap on this workload is **length and
over-answering discipline, not identification difficulty**. The repair therefore
has to be scored on the bounded outcome, with over-acting counted separately —
a candidate that identifies correctly but answers at 5× the length is not a win.

## The repair target, restated as a task shape

Stripped of anything private, the workload is: *read an inbound record, decide
which registered entity its domain belongs to among near-matches, and emit one
short bounded decision — including the explicit "no match" decision.* The
sanitized synthetic slice in `src/domain-identification-slice.ts` mirrors exactly
that shape, with four bands:

| Slice band | Mirrors |
| --- | --- |
| `direct-match` | the terse-decision mode: exactly one entity carries the domain |
| `near-match` | sibling / subdomain / different-TLD lookalikes compete |
| `parent-join` | the matched entity defers to a second hop |
| `abstain` | nothing matches, so the only correct act is the no-match outcome |

The `abstain` band is the over-acting guard in fixture form: guessing a
plausible owner scores zero rather than rounding away.

## Scope and cleanup

- No raw traces, prompts, completions, or identifiers were exported.
- Warehouse access was read-only; nothing was written back.
- No provider spend was incurred producing this memo.
