---
name: ramp-and-verify
description: Use after a route decision exists and a candidate model must take live traffic safely — "ramp this route", "move 25% of traffic to the new model", "did the route change regress anything", "roll this back", "prove the savings are real". Pre-ramp stability gates, a staged traffic ladder through the Understudy gateway dial, routed-vs-passthrough verification from captures at each step, and explicit rollback triggers.
metadata:
  understudy:
    mode: production
    safety: approval-required
    cli_required: true
---

# Ramp and Verify

Every successful journey through this library ends the same way: a candidate
won on a frozen eval and a route decision says ship it. This worker owns the
**last mile** — taking that candidate from 0% to 100% of live traffic on the
gateway dial without trusting a single lab number, and producing the measured
before/after that makes any savings statement honest. It starts where
[`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) and
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
stop.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js status --json
```

## Safety Gates

- **Every traffic change is an explicit, approved action.** Name the workload,
  the model id, the old and new percentage, and get approval in the current
  thread before each `routes set`. Never ramp two tiers in one step.
- **Disclose capture-on-by-default.** Setting a model route enables request
  capture for that workload unless capture is explicitly disabled — tell the
  developer this before the first route write and confirm the capture setting
  they want. The hosted capture behavior is documented at
  [docs.understudylabs.com/concepts/capture](https://docs.understudylabs.com/concepts/capture).
- **Snapshot before every change.** The CLI writes a route snapshot before
  route writes; verify it exists so `routes rollback` has something to restore.
- **No savings claim without a claim packet.** Measured routed-vs-passthrough
  deltas go into the evidence contract from
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) (`claim.json`);
  a tier that "looks cheaper" is not a claim.
- Captures contain raw request/response bodies. Read them through the CLI's
  redacted, metadata-first views; full payload export is opt-in, file-only,
  and approval-gated.

## Pre-ramp gates (all must pass)

1. **Frozen-eval verdict exists** — a sweep/optimization result on frozen
   splits with the incumbent baseline recorded.
2. **Repeat-replay stability.** Re-run the candidate on the frozen rows N
   times (default 3) and bucket each row: all-repeats-match / some / none
   (the procedure lives in
   [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md)).
   Rows that never repeat are stochastic pockets — assign each a disposition:
   **fallback** (route to incumbent), **shadow** (observe, don't serve), or
   **requires-fresh-traffic**. Stop if >~5% of rows are unstable.
3. **Fallback exists.** The non-routed remainder passes through to the
   incumbent by construction; confirm the workload's passthrough path works
   (`gateway probe`) before sending anything to the candidate.

## The ladder

Default tiers: **5% → 25% → 100%** (note: `routes set` defaults `--traffic-pct`
to 10 when not specified, so pass `--traffic-pct 5` explicitly for the first
tier). The dial's hosted split semantics are documented at
[docs.understudylabs.com/concepts/routing](https://docs.understudylabs.com/concepts/routing).
At each tier:

1. `understudy routes set <workload> --project <p> --model-id <id>
   --traffic-pct <pct>` — after approval.
2. **Soak.** Hold the tier for an agreed window (hours at 5%, a day at 25%)
   while traffic accumulates.
3. **Verify from captures.** Pull the window's captures (metadata-first) and
   compare routed vs passthrough on the same period: error/status-code rate,
   latency distribution, schema/parse validity of outputs, and token/cost per
   call. The routed cohort must hold the lab quality bar on whatever the
   workload's validator can score from captures.
4. **Spot-check determinism.** Re-run a small sample of routed rows against
   the candidate; if repeats disagree materially more than the pre-ramp
   measurement, stop the ramp and re-diagnose.
5. **Advance or roll back.** Advance only when the tier window is clean.
   Rollback triggers — any one fires `understudy routes rollback` (or
   `routes clear`) immediately: error rate or schema-validity regression vs
   passthrough, tail-latency regression beyond the agreed bound, instability
   above the pre-ramp measurement, or the developer's call. After a rollback,
   do not re-ramp until the root cause is fixed and the pre-ramp gates pass
   again on a fresh eval.

## After 100%

Keep the incumbent reachable (snapshot retained, rollback tested) for an
agreed observation window. Then assemble the before/after: incumbent baseline
vs routed steady-state on quality-from-captures, latency, and cost/call —
into the claim packet. That packet, not the ramp log, is what any cost or
quality statement cites.

## Output Standard

End with: the workload/project/model ids and the tier history (pct, window,
verdict per tier); the pre-ramp gate results (stability fraction, disposition
counts); per-tier routed-vs-passthrough table (errors, latency, validity,
cost/call); any rollbacks and their trigger; the current route state and
snapshot path; result type (live); and the claim-packet status with the one
recommended next action.

## References

- [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
  route/capture command surface and auth readiness.
- [`../compare-trajectories/SKILL.md`](../compare-trajectories/SKILL.md) —
  repeat-replay stability procedure and dispositions.
- [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md) — the
  frozen-eval verdict required by the pre-ramp gate.
- [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) — the
  claim-packet contract for any measured savings statement.
- Hosted contracts on the docs site —
  [routing](https://docs.understudylabs.com/concepts/routing),
  [capture](https://docs.understudylabs.com/concepts/capture), and the
  [control-plane API](https://docs.understudylabs.com/reference/control-plane)
  behind `routes set/rollback/clear` and `captures list`.
