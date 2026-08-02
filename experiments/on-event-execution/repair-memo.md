# Repair memo — synthetic workload `on-event-execution`

Neutral naming throughout. Every number below is an **aggregate** computed over
gateway outer-span telemetry; no prompt, completion, trace, request body, or
tenant/project identifier was committed, and none is reproducible from this
memo. Machine-readable form: [`aggregates.json`](aggregates.json).

## What this workload is

Event-triggered execution. An event arrives, and the model applies the effects
that event addresses — and nothing else. It is the execution end of an
orchestration chain, not the deciding end.

## Is it worth repairing?

| Signal | Value | Read |
| --- | --- | --- |
| Requests | 13,912 over 30 active days | Real, recurring traffic; not a one-off |
| Cost | $703.79, 2.24% of project spend, rank 6 of 21 | Mid-tier — worth repairing, not the headline |
| Cost per request | $0.0506 | **High** for a bounded-output task |
| Input p50 / p95 | 55,434 / 89,237 tokens | The cost is context, not generation |
| Cache-read share | 82.1% | A large, stable context is re-sent every call |
| Output p50 / p95 | 192 / 1,099 tokens | Bounded in the common case |
| Output < 256 tokens | 66.6% of requests | Bounded majority |
| Reasoning tokens | 0 | No hidden generation cost |
| Non-success | 256 / 13,912 (1.8%), all upstream | Not a quality signal; transport |

**Verdict: suitable.** Three reasons, in order of weight.

1. **The economics are context-bound, not generation-bound.** 794M input tokens
   against 5M output tokens, 82% of input served from cache. A replacement does
   not have to win on generation quality alone; it has to hold the same large
   context. That is a capability question with a clean answer, not a taste
   question.
2. **Two-thirds of the traffic is bounded output.** Bounded output dodges the
   failure mode that has killed comparable arms: small bases lose
   *sequence-length control* long before they lose tool identity, and the
   damage shows up as terminal-token repetition on variable-length generation.
   A workload whose modal output is 192 tokens does not give that failure much
   room.
3. **Repeatability.** One event schema, one standing policy, a narrow effect
   surface. This is the shape that rewards a tuned small model.

The honest counterweight: at 2.24% of project cost, a total win here is worth
roughly $700 per two months. This is a **methodology** target — a clean place
to prove the repair loop — more than a margin target. Say that plainly rather
than dressing up the number.

## The failing bands

The output-length distribution splits into three bands, and the fixture mirrors
them:

| Band | Traffic share | Fixture share | Why it is the band |
| --- | --- | --- | --- |
| bounded (≤256 output tokens) | 66.6% | 62.5% | 1–2 addressed writes, target named by the payload |
| extended (257–1024) | 27.3% | 25.0% | 3–4 writes, one create-then-act chain |
| variable (>1024) | 6.1% | 12.5% | 5–7 writes with near-miss records to disambiguate |

The variable band is deliberately over-weighted in the fixture relative to
traffic: at 6% of requests it would be 6 tasks in a 96-task slice, too few to
say anything. Over-weighting buys a measurable tail at the cost of making the
fixture mean pessimistic relative to production traffic — read the **per-band**
numbers, not the mean.

Where the base actually fails (measured, dev split, temperature 0):

- **Format adherence, not intent.** 16/16 dev episodes emitted at least one
  malformed tool call (49 malformed emissions). The policy knows what to do
  well before it can reliably say it.
- **Over-acting is not the current failure.** 0 over-acting episodes and 0
  forbidden writes on dev. The near-miss records are being left alone. This is
  the regression to *guard against*, not the one to fix.
- **The join is the hard part of the bounded band.** Direct-write
  acknowledgement scores 0.50; the same-length family that requires a
  requester→contact join scores 0.33. Length is not what makes the bounded band
  hard.

## Claim boundary

- Everything above is measured on a **synthetic** fixture that mirrors the
  workload's task shape, plus aggregate production telemetry. No production
  request was replayed and no production output was scored.
- The fixture's difficulty is authored, not sampled from traffic. A lift on this
  slice is evidence that the repair loop works on this task shape; it is **not**
  a production win, and must not be reported as one.
- The holdout split is **clean and unexecuted** by decision (see
  [`lift.md`](lift.md)). Every number here and in the lift table is train/dev.
