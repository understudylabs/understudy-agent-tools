# 30-minute grocery-platform demo

This script is for an engineering or applied-AI buyer evaluating whether a
smaller open-weight model can safely handle part of an existing workload. It
uses synthetic tasks and local models only. The purpose is to show the
replacement loop and its evidence, not to claim production readiness from
three examples.

## Before the call

Run Understudy Desktop 0.3.2+ with an Understudy E2B slot and 26B slot warm.
Confirm that agents can discover the app, then create a fresh proof:

```sh
understudy desktop capabilities
understudy desktop status --json
node experiments/desktop-grocery-proof/run.mjs \
  --student-slot 9 \
  --teacher-slot 5
```

Keep the resulting proof directory open. Do not use customer prompts, traces,
or credentials in the demo.

Open `report.html` first. It is the buyer-facing decision packet; keep the
JSONL files behind it for drill-down rather than making the terminal the demo.

## 0-3 minutes: state the decision

Say:

> You already have important AI workflows. Understudy lets us replay the same
> work across your incumbent and open-weight candidates, see exactly where the
> cheaper model fails, and capture whether escalation fixed it. You get a
> migration decision before changing production traffic.

Show that Desktop is a local control plane rather than a special demo UI:

```sh
understudy desktop contract --json
understudy desktop capabilities
```

Point out the versioned API, exact run IDs, local model residency, image
support, cancellation, replay, and supervisor feedback.

## 3-8 minutes: show one runtime, multiple routes

Explain the three frozen routes:

1. E2B alone;
2. 26B alone;
3. E2B working first while 26B supervises.

The same three tasks run through every route: codebase analysis, cart
substitution, and operations classification. The suite hash prevents a route
from receiving an easier slice.

```sh
PROOF=$(find ~/.understudy/proofs/grocery-marketplace \
  -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
jq '{proof_id, suite_sha256, task_count, run_count, slots}' "$PROOF/summary.json"
```

## 8-15 minutes: make the comparison legible

Start with the report's route comparison and per-task recommendations. If the
buyer wants the underlying numbers, show only these fields:

```sh
jq '.by_mode | with_entries(.value |= {
  exact_passes,
  task_count,
  mean_field_accuracy,
  mean_latency_ms,
  total_tokens,
  supervisor_missed_errors,
  mean_small_model_output_share,
  mean_supervisor_token_overhead
})' "$PROOF/summary.json"
```

For the measured synthetic slice, the expected story is:

- E2B handles cart substitution and operations classification.
- 26B handles all three tasks.
- E2B is faster, but misses the required atomic inventory fix.
- Supervision retains the E2B answer and the 26B judge misses that known error.

Do not hide the miss. It is the strongest product moment: Understudy tells the
team that supervision is not yet safe for code analysis instead of turning an
architecture idea into an unsupported savings claim.

## 15-22 minutes: inspect the failed judgment

Show that the failed route still has immutable, attributable evidence:

```sh
jq -s '[.[] | select(
  .event == "supervisor_verdict" or
  .event == "student_interruption" or
  .event == "teacher_continuation" or
  .event == "usage"
)]' "$PROOF/supervised-codebase-analysis.events.jsonl"
```

Call out:

- one exact `run_id` across the trace;
- stable verdict/intervention marker IDs;
- the supervisor's recorded reason and chosen-verdict first-token probability;
- separate student and supervisor token counts;
- the student partial and any teacher continuation remain separate;
- a human can label a missed intervention without rewriting history.

The question changes from “should we trust small models?” to “which workload
clusters have enough evidence to route, supervise, improve, or keep on the
incumbent?”

Do not call the first-token probability a calibrated correctness score. A
confident missed error is evidence that the judge needs work, not evidence that
the rejected student was safe.

## 22-27 minutes: show deployment safety

Demonstrate the operational surface:

```sh
understudy doctor
understudy models runtime doctor
understudy desktop status --json
understudy desktop run events <run-id> --json
```

Explain that prompts, images, completions, and proof artifacts stay local by
default; model/runtime repair is CLI-driven; Desktop owns model processes
across graceful and crash-style restarts; and agents use the same authenticated
loopback API as the UI.

## 27-30 minutes: propose a pilot

Ask the buyer to choose two or three bounded workflow clusters:

- one high-volume structured task where a smaller model should win;
- one tool-using or visual task where capability is uncertain;
- one high-judgment task expected to remain on the incumbent.

Pilot deliverable: a frozen comparison packet for each cluster containing
quality, latency, cost basis, failure modes, token attribution, intervention
precision/recall, and a route/hold recommendation. No production switch is
required to learn whether the opportunity is real.

## Audience pivots

- Engineering platform: emphasize one API, exact replay, cancellation, restart,
  tool pairing, and a reversible fallback release.
- Applied AI: emphasize failure clusters, supervisor errors, human labels, and
  correction-pair export for GEPA/SFT/RL decisions.
- Security or infrastructure: emphasize local-first storage, loopback auth,
  owner-only evidence, cached offline models, and explicit remote-route consent.
- Product or finance: emphasize measured route coverage and avoided migration
  risk; do not extrapolate savings until the buyer's frozen slice is scored.
