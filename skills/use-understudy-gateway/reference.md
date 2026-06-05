# Use Understudy Gateway — reference

Depth for [`SKILL.md`](SKILL.md). This worker is the inference/routing/capture/
deploy stage. The cross-cutting framing — intake, objective menus, the
route-selection taxonomy, and the fresh-pricing rule — lives in the orchestrator
and is not duplicated here. Read
[`../understudy/reference.md`](../understudy/reference.md) for route selection
across harness/model/supplier/strategy and for the rule that pricing,
availability, and capability claims must come from fresh data, never memory.

The two workflows below are the domain depth this worker owns: capturing model
calls into a trace inventory, and deploying an improved behavior through the
inference layer with a measured before/after comparison.

## Workflow 1 — Trace capture

Goal: turn a running app's LLM calls into a local, redacted trace inventory the
rest of the loop can score, without changing app behavior and without uploading
anything that the developer has not approved.

1. **Find the LLM call sites.** If the call sites are already known, list them.
   Otherwise defer discovery to
   [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md), which scans
   the repo read-only for model clients, prompt strings, eval suites, and trace
   exports. Do not duplicate that scan here; carry its inventory forward.
2. **Determine whether gateway routing is already present.** Check whether calls
   already go through an Understudy gateway base URL / the `understudy run`
   wrapper, or hit a provider SDK directly. This decides whether capture is a
   config flip or needs a collector in front of the existing client.

   ```sh
   understudy status --json
   ```
3. **Configure trace capture, preserving the app interface.** Prefer the path
   that leaves the application code untouched:
   - *Gateway already in place* — enable gateway trace capture for the workload
     so calls are recorded as they pass through. The app keeps calling the same
     base URL.
   - *Provider SDK direct* — point the existing client's base URL at the gateway
     (an OpenAI-compatible base URL plus the injected key from
     `understudy run`), so the SDK, request shape, and response shape are
     unchanged and only the endpoint moves.
   - *Restricted / offline* — when the environment is local-only or hosted
     capture is disallowed (for example a ZDR constraint, see
     [`../understudy/reference.md`](../understudy/reference.md) → Constraints),
     do **not** route through the hosted gateway. Stand up a local trace
     collector (a logging wrapper or local proxy in front of the existing
     client) that writes traces to disk only.
4. **Capture the full record per call.** Each trace row should include: the
   model id requested and served, the rendered request messages, the response
   text, any tool calls and tool results, latency, error/status, token usage
   (prompt/completion/total), and run metadata (timestamp, workload id, route,
   attempt/retry, split or fixture ref). This is what later steps need to score
   quality, cost, and latency together.
5. **Redact sensitive values before anything leaves the call site.** Strip or
   hash secrets, API keys, PII, and customer-identifying fields. Record redacted
   examples and field schemas rather than full message bodies when the payload
   class is sensitive. Follow
   [`../../docs/privacy-and-data-boundaries.md`](../../docs/privacy-and-data-boundaries.md).
6. **Do not upload in local-only or restricted modes.** In local-only mode, or
   under a ZDR / no-hosted-upload constraint, traces stay on disk and are never
   sent to the hosted platform. Hosted capture and any upload require explicit
   confirmation of the exact action and data class (unless unattended mode is
   set). State where traces are written.
7. **Produce a trace inventory.** Summarize counts, the distinct call sites and
   models covered, the captured fields present per row, latency/token/error
   distributions, the redaction applied, and the on-disk path — paths, counts,
   hashes, and schemas, not raw payloads. Hand the inventory to
   `capture-evidence` to become `harness.json` / `splits.json` / `baseline.json`.

Write capture artifacts under a local path such as
`.understudy/use-understudy-gateway/traces/`.

## Workflow 2 — Deploy and compare

Goal: ship the smallest viable improvement through the inference layer, prove it
against the baseline, and make rollback and any regression obvious. Confirmation
rules below apply to every upload, spend, credential, deploy, or route change.

1. **Keep the baseline reproducible.** Pin the incumbent route, the frozen eval
   split, and the captured baseline metrics before changing anything. Reuse the
   `capture-evidence` `baseline.json` contract so the comparison is hash-bound to
   the same harness, metric, and splits.
2. **Apply the smallest viable change.** Prefer a config or route change over
   editing hardcoded call sites: a model swap, a routed traffic split, a prompt
   variant, or a parser fix is usually enough. Editing call sites directly is the
   last resort and must be reversible.
3. **Register / route the improved behavior through the inference layer.** Use
   the workloads route API to send a bounded share of traffic to the improved
   model. The app keeps calling the normal gateway path; the control-plane route
   decides the split. The traffic percentage is a per-request share.

   ```sh
   understudy models list --json
   understudy workloads route <workload-id> --project-id <project-id> --model-id glm-5.1 --traffic-pct 10
   ```

   See [`SKILL.md`](SKILL.md) → A/B model routing for the full split mechanics
   and the managed-frontier prerequisite for a frontier comparison.
4. **Local-only mode: write a deployment artifact instead of routing.** When no
   hosted route is allowed, write the chosen route to a local deployment artifact
   / `understudy.yaml` (model id, traffic intent, prompt/parser version, baseline
   refs) so the change is captured and reproducible without touching the hosted
   control plane.
5. **Include rollback steps.** Record the exact command to revert. For a routed
   change that is clearing the route back to full passthrough:

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --clear
   ```

   For a local artifact, rollback is restoring the previous `understudy.yaml` /
   config. Always state the demotion trigger that should cause a rollback.
6. **Run comparison evals.** Drive the same frozen eval through the gateway so
   the routed share is served by the improved model, and score it on the same
   metric and split as the baseline.

   ```sh
   understudy run -- <eval command>
   ```
7. **Show before/after metrics and list regressions.** Report the baseline and
   candidate side by side on every affected axis — quality, cost (tokens and
   spend), latency, and reliability — and call out per-row or per-axis
   regressions explicitly. Never bury a regression behind an aggregate win: a
   quality gain bought with higher latency or more tool calls must be visible.
   For a measured improvement statement, route the claim through
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md), which binds
   it to a claim packet.

## Confirmation gate

Any action that uploads data, spends provider budget, changes credentials,
deploys behavior, or alters a production route requires explicit confirmation of
the exact action and data class in the current thread — unless unattended mode is
configured. State the surface, the data class, and the spend or traffic bound
before acting. Discovery, local capture, redaction, and reading status are
local-only and do not need spend approval.
