# Compounding loop — production work becomes the next model

The method ladder ([`../skills/optimize-workload/references/method-ladder-policy.md`](../skills/optimize-workload/references/method-ladder-policy.md))
answers *which* intervention to spend on. This document specifies the loop that
keeps feeding it: the work a deployed workload does today becomes the training
signal that improves it tomorrow, instead of evaporating.

```text
production capture (object store)
  -> verifier outcome + human correction
  -> auto-appended SFT / preference / RL data
  -> retrain trigger on drift or volume
  -> promote on sealed-holdout evidence
  -> monitor live quality  ──┐
  ^                          │
  └──────────────────────────┘
```

Every stage is append-only and evidence-gated. Nothing in the loop promotes a
model; only the promotion bar does.

## 1. Production capture

Each served call writes one immutable record to object storage (R2 or any
S3-compatible bucket), partitioned by workload and hour:

```text
s3://<bucket>/<workload>/dt=<YYYY-MM-DD>/hh=<HH>/<capture_id>.jsonl
```

Record fields: `capture_id`, `workload`, `ts`, `route` (model + version +
prompt hash), `inputs`, `output`, `tool_calls`, `latency_ms`, `token_usage`,
`cost_usd`, and a `redaction` marker. Capture is write-once: corrections are new
records that reference `capture_id`, never edits.

Boundaries that are not negotiable:

- Redact at the writer, before the bytes leave the process. Applying the
  repo public boundary
  ([`privacy-and-data-boundaries.md`](privacy-and-data-boundaries.md)) at read
  time is too late.
- Sample rather than capture everything when volume is large — but sample
  *deterministically by input hash*, so the same rows recur across days and
  drift is measurable.
- Rows destined for the sealed holdout are partitioned at capture time and are
  never eligible for training append. Contaminating the holdout invalidates
  every later promotion.

## 2. Verifier outcome and human correction

A scheduled job scores captured rows with the workload's verifier and writes an
outcome record per row: `capture_id`, `metric_name`, `score`, `unscored`
(excluded from averages rather than counted as zero), and `verifier_version`.

Rows the verifier marks failing — plus a small random sample of passing rows,
to catch a verifier that has gone blind — go to a human review queue. A
correction record carries `capture_id`, `corrected_output`, `reason_code`, and
the reviewer's confidence. Corrections are the highest-value asset in the loop:
they are the only signal that encodes judgment the verifier cannot express.

Two invariants:

- The verifier is versioned. A verifier change invalidates comparability, so it
  bumps the version and starts a new evidence window rather than silently
  re-scoring history.
- Disagreement between verifier and human is itself a tracked metric. A rising
  disagreement rate means the metric is drifting away from the outcome, and the
  correct response is to repair the metric, not to retrain the model.

## 3. Auto-append training data

An append job derives datasets from outcome and correction records. Nothing is
generated here; each row is traceable to a `capture_id`.

- **SFT rows**: corrected outputs, and verifier-passing outputs above a score
  threshold. Deduplicate by input hash, keep the most recent correction.
- **Preference pairs**: `(chosen, rejected)` where `chosen` is the correction or
  the higher-scoring route output and `rejected` is the failing production
  output. Pairs must come from a verifier outcome or a human correction — never
  from a second model's unverified opinion.
- **RL signal**: `(input, reward)` from programmatic verifier scores only, for
  workloads that have a simulated rollout environment.

Each dataset carries a manifest: source window, row counts, split assignment,
and the hash chain the claim packet will later cite. Holdout-partitioned
captures are excluded by construction, and the append job fails closed if a
holdout hash appears in a training shard.

## 4. Retrain trigger

Retraining is triggered by evidence, not by a calendar. Evaluate on a schedule;
fire when any of these hold:

- **Volume**: new eligible rows since the last training run exceed the ladder's
  data minimum for the rung under consideration (see the policy table) — enough
  new signal to plausibly move the metric.
- **Drift**: live score on the rolling window drops by more than the material
  delta (default 0.02) versus the promoted model's holdout score, or the input
  distribution shifts (new label mix, new tool set, novel-input rate above
  threshold).
- **Correction pressure**: the human-correction rate on sampled rows rises above
  its baseline — the model is failing in ways the verifier alone was tolerating.
- **Economics**: incumbent spend or volume changes enough that a previously
  unaffordable rung now pays back inside the horizon.

The trigger does not choose the method. It calls the selector with the current
workload characteristics and the freshly appended evidence, and the selector
returns the rung, the promotion bar, and the stop rules for that cycle:

```sh
understudy method-ladder recommend --input ladder-input.json --out ladder-decision.json
```

A trigger that returns `collect_evidence`, `blocked`, or `stop` is a valid
outcome. Most cycles should not spend.

## 5. Promote on evidence

A candidate is promoted only against the sealed holdout, at the bar declared
before the cycle started: minimum score, maximum regression versus incumbent,
minimum holdout rows, maximum cost per month. Claims require the claim packet
and rigor fields the optimizer skill already mandates — trivial-agent floor and
bootstrap confidence intervals. Overlapping intervals are an optimization lead,
not a win.

Promotion is a ramp, not a switch: shadow, then a small live percentage, then
full, with the incumbent route kept warm as the declared fallback and a written
demotion trigger.

## 6. Monitor live quality

After promotion the same capture stream becomes the monitor. Track, per route
version: live verifier score against the holdout score at promotion, correction
rate, novel-input rate, latency and cost per call, and the fallback/demotion
counter. A live score that falls below the demotion trigger rolls back
automatically; it does not wait for the next training cycle.

Monitoring output is the next cycle's drift input. That closure is the point:
each pass leaves behind more corrected data, a sharper verifier, and a tighter
bar, so the cost of the next improvement falls while the evidence behind it
grows.

## Thin glue only

The loop is deliberately assembled from small, independently runnable jobs —
capture writer, scorer, review queue, append job, trigger evaluator — connected
by object-store paths and versioned JSON documents rather than by a framework.
Each job is restartable, append-only, and inspectable with the CLI. The only
component this repo ships for the loop is the selector at step 4; the rest is
specified here so each arm implements the same contracts.
