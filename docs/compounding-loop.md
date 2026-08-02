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

## Running under a durable run controller

This design deliberately ships **no controller**: no poller, no queue, no second
state database. Each stage is either an idempotent step or an immutable artifact
contract, so a single durable run controller can own orchestration while this
repo owns the spec and the policy.

Rules every stage here obeys:

- **Refs, not payloads.** Controller state carries artifact refs plus their
  `sha256` — dataset manifests, capture partitions, holdout hashes, adapter
  locations. Raw traces, prompts, labels, credentials, and weights never enter
  run state or an event.
- **Deterministic idempotency.** Any step that submits long or paid provider
  work (training, batch scoring, rollouts) returns a job reference immediately
  and keys on `(experimentId, candidateId, attempt)`. A retry returns the
  existing job; it never buys a second one. Submit / inspect / cancel /
  reconcile-usage are separate calls against that reference.
- **Redacted events.** Progress is emitted as small run / candidate / rollout /
  score / usage / error events. Liveness of an executor is not evidence of
  progress and is never used as one.
- **Executors stay executors.** Training and rollout backends run work; they do
  not decide promotion. The promotion bar and the stop rules live in the
  artifacts described here.

### Evidence semantics that must survive the handoff

Whatever runtime executes the loop, these distinctions are load-bearing and must
be carried explicitly rather than flattened into a single number:

- **Budget vs actual vs estimated vs upper-bound spend** — never report an
  estimate where an actual is expected, and label upper bounds as such.
- **Evidence scope and request isolation** — which rows, which window, and
  whether the runs were isolated from each other.
- **Hash-bound splits** — the split contract travels as a hash, and a
  regenerated split is a new contract, not the same one.
- **Holdout clean vs executed** — a holdout that has been run against is no
  longer sealed; it is structurally absent from anything a training or rollout
  step can read.
- **Quality and calibration status** — a score without its calibration state is
  not comparable across cycles.
- **Failure clusters** — the failure taxonomy, not just the aggregate score, is
  what selects the next rung.
- **Artifact refs and the claim boundary** — what may be claimed publicly is a
  property of the evidence, and it travels with it.

The selector consumes the summary form of exactly these fields (`verifier`,
`sealed_holdout_rows`, `metric_name`, scores, `failure_mode`, cost per month,
attempts) and emits a hashed decision artifact. It never sees holdout rows,
because it never sees rows at all.

The selector at step 4 is the reference shape for a pure step:

```ts
methodLadderStep(input, { experiment_id, candidate_id, attempt })
// -> { schema_version: "understudy.method_ladder.step.v1",
//      idempotency_key, input_sha256, ref, recommendation }
```

It is a total function of an evidence summary — counts, scores, costs, booleans;
no rows — so the same input always yields the same decision artifact, the hash
is canonical (keys sorted) and stable across retries, and replaying the step
costs nothing. Persist the returned document as the decision artifact for that
attempt and reference it by hash from run state.
