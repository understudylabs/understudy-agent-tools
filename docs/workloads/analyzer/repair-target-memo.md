# Repair-target memo — synthetic workload `analyzer`

Aggregates only. Every number here comes from gateway telemetry rollups
(counts, tokens, USD, distributions) over a design-partner project. No raw
requests, responses, prompts, completions, or identifiers were read into this
repo, and none are committed. The machine-readable form is
[`aggregates.json`](aggregates.json).

Window: 2026-06-26 → 2026-08-01.

## Verdict up front

**Repair-suitable on task shape, not on economics.** `analyzer` is the
cleanest *bounded-output* target in the project — it structurally dodges the
variable-length tool-call failure mode that sank the prompt-into-weights
attempt on the orchestrator-shaped workloads — but it carries 0.18% of project
spend. Treat it as a **methodology-validation arm**, not a cost-recovery arm.
Do not quote savings from it.

## Volume and cost

| Metric | Value |
| --- | --- |
| requests | 904 |
| share of project requests | 0.10% |
| customer cost | $57.05 |
| share of project cost | **0.18%** |
| cost per request | $0.0631 |
| monthly | $3.07 (Jun, partial) → $53.12 (Jul) → $0.86 (Aug, partial) |

Incumbent is effectively a single frontier model: `claude-sonnet-4-6` carries
819 of 904 requests and $53.95 of $57.05. A 71-request `claude-sonnet-5` tail
and 14 open-weight probe requests make up the rest. Single-incumbent traffic is
good for a replacement arm — there is one behavior to match, not a blend.

## Shape: bounded output over a long, lightly-cached input

| Percentile | input tokens | output tokens |
| --- | --- | --- |
| p10 | 5,660 | 107 |
| p50 | 8,950 | 238 |
| p90 | 42,878 | 1,016 |
| p95 | 54,792 | 1,142 |
| p99 | — | 1,438 |
| max | 470,205 | 2,389 |

Output-to-input ratio is **0.019** — this is a read-a-lot, say-a-little job.
Output p95 of 1,142 tokens with a hard-looking ceiling near 2.4K is *bounded*:
75% of requests finish under 400 output tokens and the distribution has no
runaway tail. That matters because the known failure mode for a small base on
this customer's traffic is **sequence-length control**, not task identity — a
workload whose correct answer is short cannot express that failure.

Two things are worth flagging to the workload owner independent of any model
swap:

- **Cache read share is 3.4%.** On a workload whose p50 input is ~9K tokens and
  whose instruction preamble is presumably fixed, near-zero prompt caching is
  the single largest cheap win available. It is an integration change, not a
  model change.
- **Input p95 is 6× input p50** (54.8K vs 9.0K). The long-input tail is where
  cost and latency actually live, and it correlates with the long-output tail
  (band D input p50 is 30.0K vs band A's 6.9K).

## Bands and where the failure is

Bands are cut on output length, because that is the axis the repair has to hold.

| Band | requests | % | output p50 | input p50 | cost | cost % | avg latency | errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A short (0–150) | 227 | 25.1% | 114 | 6,904 | $7.55 | 13.2% | 3.2s | 29 |
| B mid (151–400) | 448 | 49.6% | 238 | 7,563 | $22.85 | 40.1% | 5.6s | 0 |
| C long (401–900) | 100 | 11.1% | 756 | 24,073 | $10.06 | 17.6% | 18.3s | 0 |
| D xlong (900+) | 129 | 14.3% | 1,069 | 29,969 | $16.59 | 29.1% | 26.4s | 0 |

- **A+B are 74.7% of requests and 53.3% of cost**, and they are short, fast, and
  clean. This is the repair target: a bounded structured verdict over a
  moderate context.
- **C+D are 25.4% of requests but 46.7% of cost and 4–8× the latency.** The
  cost concentration here is driven by input length, not by output length. A
  small candidate should be gated separately on C+D, and a long-context
  candidate is a different question from a bounded-verdict candidate.
- **All 29 errors sit in band A**, all HTTP 400 with `error_origin=provider` —
  a 3.2% overall error rate, and the zero-output rows in the distribution are
  these. These are rejected requests, not bad answers; they are a request-
  construction issue upstream of any model choice and should not be scored as
  model failures.

## Repeatability

The exact-payload repeat rate is 0% (904 distinct payload hashes over 904
requests). This does **not** mean the work is non-repetitive: `payload_hash`
hashes the request payload, so any varying field defeats it, and it is not a
semantic task fingerprint. Judging true repeatability needs capture bodies or a
stable task fingerprint, which is deliberately out of scope under the privacy
boundary here. Repeatability is therefore recorded as **unknown**, and the
suitability judgment below does not lean on it.

## Suitability judgment

| Criterion | Reading |
| --- | --- |
| Volume | **Weak.** 904 requests over five weeks is thin for evidence; per-band n as low as 100. |
| Cost | **Weak.** $57.05, 0.18% of project spend. Even a 100% saving is unquotable. |
| Repeatability | **Unknown.** Not establishable from aggregates; see above. |
| Bounded output | **Strong.** p95 1,142, hard-looking ceiling ~2.4K, out/in ratio 0.019. Dodges the variable-length failure mode outright. |
| Single incumbent | **Strong.** 91% of requests on one frontier model. |
| Failing bands | C and D (long input, long output, 18–26s latency, 46.7% of cost). |

So: the honest read is that `analyzer` should be repaired **because it is the
cleanest place to prove the bounded-verdict DPO lane works**, and the result
should then be carried to a workload with real volume. The two workloads that
would actually move the bill are two orders of magnitude larger, and both are
orchestrator-shaped — which is exactly why proving the bounded-output lane
first is worth the cheap arm.

The improvement arm therefore builds a synthetic slice that mirrors this task
shape (long evidence in, one small structured verdict out, over-claiming
penalized) rather than reusing the REST-automation fixture, and reports lift
per band. See [`gate-validation.md`](gate-validation.md) and
[`dpo-lift.md`](dpo-lift.md).
