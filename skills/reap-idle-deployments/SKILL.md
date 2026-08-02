---
name: reap-idle-deployments
description: Use when someone asks "why is our GPU bill so high", "what dedicated deployments are still running", "which sweep arm is worth the money", "did anyone shut down that fine-tuning deployment", "kill the idle deployments", or wants a live scoreboard of verifier score against dollars per hour during a parallel training sweep.
metadata:
  understudy:
    mode: interactive
    safety: dry-run-by-default
    cli_required: false
---

# Reap Idle Deployments

Parallel training sweeps leave dedicated GPU deployments behind. A single
forgotten multi-GPU deployment bills tens to low hundreds of dollars per hour
whether or not anything is scoring against it. This skill gives every arm two
things: a scoreboard that ranks arms on **verifier score and $/hr together**,
and a reaper that scales to zero — then deletes — deployments past the TTL their
owner declared.

Checked against existing skills: `plan-hosted-run` owns choosing and launching a
hosted run and its spend envelope; `watch-logs` owns following a running job;
`inspect-billing-sources` owns reconciling invoices. This skill owns the live
fleet view and the cleanup of deployments the sweep no longer needs.

## Safety Gates

- The reaper is **dry-run by default**. Executing requires both `--apply` and
  `--yes`, and `--apply` is refused against an offline fixture.
- A deployment without both an owner tag and a TTL signal is reported as
  `review` and is **never** scaled down or deleted. Missing tags mean unknown
  ownership, and an arm that is still running must not be taken down by
  automation.
- Scale-to-zero comes before deletion: a deployment is only deleted once it is
  already at zero replicas and still past TTL by the delete window (24h by
  default). Pass `--delete-after-hours never` to disable deletion entirely.
- Use `--protect <owner|arm|name>` for anything that must survive the pass, and
  do not treat the estimated `$/hr` as a bill — provider billing is
  authoritative; the rates here are order-of-magnitude estimates.
- Read the API key from `FIREWORKS_API_KEY` in the environment. Never paste it
  into a command line, a config file, or a commit.

## Tagging convention — every deployment carries owner and TTL

An arm that creates a deployment must attach these tags (provider annotations
or labels; the description field is read as a fallback):

| tag | required | meaning |
| --- | --- | --- |
| `understudy.owner` | yes | who to ask before killing it — an arm runner, job, or person handle |
| `understudy.ttl-hours` | yes (or `expires-at`) | hours from creation the deployment is expected to be needed |
| `understudy.expires-at` | yes (or `ttl-hours`) | absolute ISO expiry; wins over `ttl-hours` |
| `understudy.arm` | recommended | joins the deployment to its verifier score row |

Build the map instead of hand-writing it, so a bad TTL fails at creation:

```js
import { buildDeploymentTags } from "../dist/fleet/index.js";
const annotations = buildDeploymentTags({ owner: "arm-a-runner", ttlHours: 4, arm: "arm-a" });
```

An arm that needs longer just refreshes `understudy.expires-at`; the reaper only
reads what the tags say at the moment it runs.

## Scoreboard — score and $/hr on the same row

```sh
FIREWORKS_API_KEY=... node scripts/fleet-scoreboard.mjs --scores scores.json
```

`scores.json` is `[{ "arm": "arm-a", "score": 0.82, "split": "dev" }]`. Rows are
matched to deployments by the `understudy.arm` tag, then by deployment name.

```
SCORE  $/HR   SCORE/$  STATE  AGE_H  OWNER            ARM  <- baseModel
0.820   11.0    0.075  LIVE     6.0 arm-a-runner     arm-a <- base-8b [expired]
0.410    5.5    0.075  LIVE     1.0 arm-b-runner     arm-b <- base-8b
    -  120.0        -  LIVE    40.0 -                orphan <- base-70b [burn-without-score,untagged]

est burn ~$137/hr | untagged ~$120/hr | unscored ~$120/hr
```

Read the two gap totals first. `unscored` burn is spend no verifier result is
attached to; `untagged` burn is spend nobody has claimed. Both are the orphan
signature. `SCORE/$` ranks arms by reward per dollar-hour so a marginally better
arm on far more expensive hardware stops looking like the winner.

`scripts/gauntlet-monitor.mjs` remains the burn-only view when there are no
scores yet.

## Reaper — plan first, then apply

```sh
FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs                # dry-run plan
FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs --apply --yes  # execute
```

```
DRY-RUN  grace=0.5h delete-after=24
review         120.0          - -                orphan — missing owner+ttl tag — not reaped automatically
scale-to-zero   11.0        2.0 arm-a-runner     arm-a — 2.0h past TTL
keep             5.5       -7.0 arm-b-runner     arm-b — within TTL
```

Show the user the dry-run plan and the reclaimable `$/hr` before applying. Then
work the `review` rows by hand: find the owner, and either tag the deployment or
shut it down deliberately. Every `review` row is a gap in the convention, not a
reaper failure.

Run the reaper on a schedule (hourly is enough) with `--json` so the plan is
machine-readable, and alert on `counts.review > 0` or a rising
`totals.unscoredBurnUsdPerHr`.

## Inside a durable workflow

The scripts are thin callers of one idempotent step — there is no controller,
poller, or second state store here. A workflow calls it directly:

```ts
const result = await runFleetReapStep({
  controlPlane,                 // { listDeployments, scaleToZero, deleteDeployment }
  experimentId, candidateId, attempt,   // idempotency key is derived from these
  apply: true,
});
// result.idempotencyKey === `fleet-reap:${experimentId}:${candidateId}:${attempt}`
```

The step returns immediately — it only reads and mutates the control plane, and
never waits on GPU work. Retrying the same `(experimentId, candidateId,
attempt)` converges: scaling an already-zero deployment is a no-op and deleting
an already-gone one is recorded as `already-absent`, so a retry never produces a
second effect. Real control-plane failures propagate so the workflow, not this
step, owns retries.

It emits two immutable artifacts — `understudy.fleet_scoreboard.v1` and
`understudy.fleet_reap_plan.v1` — plus small redacted `understudy.fleet_event.v1`
events (`usage`, `scoreboard`, `reap_plan`, `reap_action`, `error`) carrying
scalar cost/ownership facts only. Pass artifact **refs** (`uri` + `sha256`)
through workflow state, never the bodies, and never traces, prompts, labels,
credentials, or weights. `--artifact-dir` writes both artifacts and prints their
refs.

## Deeper notes

Policy tuning, the JSON shapes, the module API for building this into another
harness, and the offline fixture workflow are in
[`reference.md`](reference.md).
