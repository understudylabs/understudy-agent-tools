# WL-OR repair memo — the "orchestrator" synthetic workload

Aggregates only. Every number here comes from gateway telemetry counted in
place; no rows, prompts, completions, identifiers, or customer text were
exported, and none are committed. Raw numbers:
[`artifacts/telemetry-aggregates.json`](artifacts/telemetry-aggregates.json).

## What the workload is

A multi-step orchestration controller: it reads conversation state, updates the
addressed entity or agent state, edits the referenced document, and persists a
completion summary. One request is one controller decision, not one user turn.

## The shape, in numbers

| Aggregate | Value |
| --- | --- |
| requests (20 active days) | 2,481 (≈124/day) |
| customer cost | $406.49 (1.3% of project cost, 10th of 21 workloads) |
| cost per request | $0.164 |
| input tokens | 128.4M uncached + 11.3M cache-read + 2.0M cache-create |
| cache-read share of input | 8.0% |
| input tokens p50 / p95 | 53,290 / 95,519 |
| output tokens p50 / p95 / max | 202 / 698 / 2,095 |
| output length CV | 0.79 |
| episodes ≤1,024 output tokens | 98.8% |
| latency p50 / p95 | 5.1s / 16.1s |
| success rate | 99.9% (2 upstream errors) |

## Repair suitability

**Verdict: repairable, but a second-wave target — the case is behavioural, not
economic.**

- **Bounded output — the good news.** p95 is 698 tokens and 98.8% of episodes
  finish under 1,024, with CV 0.79. This workload therefore dodges the
  variable-length tool-call failure mode that sank prompt-into-weights SFT on a
  small base: there is no long, open-ended emission for a small model to fall
  into a terminal-token repetition loop on. Output-length control is not the
  thing that has to be learned here.
- **Repeatable.** One task shape, one incumbent model, ~124 requests/day at a
  steady rate over the whole window. A tuned policy sees the same decision
  again and again, which is exactly what a small model can absorb.
- **Cost is the weak leg.** $406 over 20 days is 1.3% of project spend. Even a
  total replacement saves low hundreds of dollars per month, so this workload
  does not pay for a repair campaign on its own — it pays as the *pattern
  carrier* for the far larger orchestration workloads on the same task shape.
- **The cost is on the input side.** 91% of input tokens are uncached and the
  median request carries ~53K input tokens against a ~202-token answer: a
  640:1 read-to-write ratio. Cache-read covers only 8% of input. The dominant
  lever is prompt/context, not generation, and a cheaper policy only converts
  into savings if it keeps the same context budget or the context is cut with
  it.

## Where the failing bands are

Measured on the sanitized synthetic slice (WL-OR, gates green — see
[`benchmark-validation.md`](benchmark-validation.md)), the candidate open-weight
base is nowhere near incumbent behaviour:

| Band | Slice dev tasks | Base mean |
| --- | --- | --- |
| multi-write | 4 | 0.063 |
| single-write | 1 | 0.000 |
| **all** | **5** | **0.050** |

Failure modes, in order of size:

1. **Emission discipline.** Every base episode contained at least one malformed
   emission (rejected, never repaired). Rejected turns burn the step budget, so
   the episode dies before the chain finishes.
2. **Over-action.** 2 of 5 dev episodes wrote outside the addressed set, which
   zeroes the episode regardless of the rest of the chain. This is the
   regression the repair must not amplify.
3. **Chain completion.** Even parsed episodes drop a leg — read, update, then
   never persist the summary.

The repair target is therefore *format discipline and write scoping first,
chain completion second* — which is what the near-hit preference pairs in this
arm are mined to teach.
