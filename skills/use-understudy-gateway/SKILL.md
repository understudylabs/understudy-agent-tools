---
name: use-understudy-gateway
description: Use when a developer wants to run inference or evals through the Understudy gateway — "route my app through Understudy", "set up my account and keys", "A/B a model on part of my traffic" — or must choose between local provider keys and the gateway route ("should I use my OpenAI key or the gateway"). Handles login, projects/keys, model routing, and runs.
metadata:
  understudy:
    mode: interactive
    safety: auth-gated
    cli_required: true
---

# Use Understudy Gateway

Use this worker when the developer wants to run an application workload through
Understudy-managed inference or needs the CLI to execute a durable command while
the agent monitors status and artifacts.

The local evidence loop does not require auth. Route here only when the developer
explicitly asks for Understudy inference, gateway routing, project/key
management, workload route configuration, hosted execution, or authenticated
gateway routing.

**Choosing frontier access?** When an onboarding step, installer, or
local-vs-frontier comparison needs a remote frontier model, run the decision in
[`references/frontier-keys.md`](references/frontier-keys.md) first. Default to
the Understudy managed catalog when the requested model is available there; use
BYO shell/`.env` keys only for unsupported models, provider-specific account
needs, or an explicit developer preference. It keeps secrets local, asks before
reading `.env` values, and records the choice without printing keys.

## Safety Gates

Do not ask the developer to paste an API key. Use the CLI registration flow and
let the CLI store credentials outside the repo.

Do not print, commit, or write `sk_*` values into artifacts. `understudy run`
injects `UNDERSTUDY_API_KEY`, `UNDERSTUDY_GATEWAY_URL`, and the non-secret
`UNDERSTUDY_ORG_ID` when known only into the child process environment.

Do not run provider calls, uploads, hosted jobs, or model downloads without the
developer approving the exact command, data class, and spend or download bound.

## Always stream gateway inference

Every inference request sent to the Understudy gateway (`/v1/messages` or
`/v1/chat/completions`) must set `stream: true`. This is not a style
preference: the gateway sits behind an edge that cuts any origin response
producing no first byte within ~125 seconds and returns a 524 to the client.
A non-streaming request holds the response open for the model's full
generation time, so a slow generation can cross that limit and fail — and a
524 carries no usage block, so the request's tokens cannot be metered. With
`stream: true` the upstream returns headers and SSE framing within seconds,
so the first-byte timeout can never fire regardless of generation length.

If the caller needs the full response as a single object, still stream — then
aggregate locally. Do not "simplify" a streaming call back to `stream: false`.
For OpenAI-shape streaming requests the gateway injects
`stream_options: { include_usage: true }` upstream itself, so the final SSE
chunk carries usage without the caller setting anything. Aggregation patterns
per client (Anthropic SDK, OpenAI SDK, raw fetch/SSE) are in
[`reference.md`](reference.md) → "Always-stream rule".

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js status --json
```

## Flow

1. Check whether auth is already configured:

   ```sh
   understudy status --json
   ```

2. If not signed in, register/sign in with the two-phase email-code flow:

   ```sh
   understudy login --email <developer-email>   # emails a one-time code, then exits
   understudy login --code <one-time-code>      # completes the sign-in
   ```

   In a non-TTY shell (an agent's shell) the first command sends the code and
   exits with instructions; the pending claim is saved under
   `~/.understudy/login-pending.json`, so no interactive prompt has to be held
   open — no tmux or expect tricks. In an interactive terminal the same command
   prompts for the code inline instead. Codes expire after about 10 minutes;
   rerun `--email` to send a fresh one.

   This creates or finds the developer's Understudy account, retrieves an API
   key through the CLI, and stores it outside the repo. The key is used for
   authenticated gateway inference, project/key management, and remote model
   routes. Do not ask the developer to paste the key.

   Ask the developer to read the one-time code from their inbox. An agent with
   an approved native email connector may instead search narrowly for the fresh
   Understudy sign-in email and pass the code to `understudy login --code`. Read
   only that email, and do not persist the code anywhere else.

3. Confirm project/key readiness:

   ```sh
   understudy projects list --json
   understudy keys list --json
   ```

4. For frontier-vs-Understudy comparison, list public model IDs first. If the
   account is keyless for frontier providers, prefer the **keyless catalog
   sweep** recipe below: clear the workload route and vary the request-body
   `model`. Use traffic-split A/B only after confirming the non-routed
   passthrough share has a managed provider credential or BYO key.

5. Run the local command through the gateway wrapper only after approval:

   ```sh
   understudy run -- <local command>
   ```

   **Run this as a background task — do not block the agent thread on it.**
   Eval runs can take minutes to hours depending on row count and model latency.
   Send it to the background immediately and move on to other work. See
   [`../../docs/background-ops.md`](../../docs/background-ops.md) for the
   shell patterns and how to tail the log and check the exit code.

6. Monitor the command output and local artifacts by tailing the log rather than
   blocking the agent. While the run is in flight, advance the loop steps that
   don't depend on its output: cost-model the candidate models, pull benchmark
   context for the comparison, and scaffold the evidence artifacts
   ([`../understudy/reference.md`](../understudy/reference.md) § "Understudy
   Agent Improvement Report"). Surface a notification when the run completes;
   do not silently continue. For route work, route back to
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) once the run
   has produced candidate/proof evidence. See
   [`../../docs/background-ops.md`](../../docs/background-ops.md) for the exact
   tail/poll and exit-code patterns.

## Keyless catalog sweep

Use this recipe for the fastest frontier/open-weight comparison when the
developer does not have, or does not want to use, provider keys. The same
Understudy key can request supported Anthropic, OpenAI, and open-weight catalog
models by public id.

1. Discover public model options:

   ```sh
   understudy models list --json
   ```

2. Ensure the eval workload has **no route configured**. A route dialed to 0%
   still counts as configured and prevents request-time catalog resolution.

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --clear
   ```

3. Run the frozen eval once per catalog model by changing only the request-body
   `model` value. Send `x-understudy-project` and `x-understudy-workload` on
   every request so the run does not accidentally use the org default workload.

4. Record the legibility headers for every row: `x-understudy-mode`,
   `x-understudy-route`, and `x-understudy-effective-model`. Treat rows where the
   requested model and effective model disagree as invalid for model comparison.

5. Unknown ids for a keyless managed org return a clean catalog-miss 404 with
   available alternatives. Do not expect arbitrary frontier names to passthrough
   unless the org has its own managed provider key or the request supplies BYO
   credentials.

6. Bound the run by row count, max tokens, and wall-clock time. New accounts get
   prepaid credit and async suspension, not a synchronous per-request spend
   reservation.

## A/B model routing

Use this recipe to A/B a chosen public model against passthrough while an eval
runs through the gateway. A typical consumer is
[`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md),
comparing a workload's quality and cost across the split.

1. Discover public model options (public model IDs only; no supplier detail):

   ```sh
   understudy models list --json
   ```

   The same catalog is enumerable in-band via OpenAI-compatible
   `GET {gateway}/v1/models` with the `sk_*` key — `OpenAI(...).models.list()`
   works — useful from a harness that already speaks the OpenAI SDK.

   The list is the remote ladder. It should include larger Gemma-family routes
   when enabled for the account, so the same API key can graduate a workload from
   the local Gemma 4 E2B first rung to larger Gemma variants or remote/hybrid
   routes without changing application code.

   **Eval shortcut — request-time catalog resolution.** On a workload with **no
   route configured** (never routed, or explicitly `--clear`ed — a route dialed
   to 0% still counts as configured and stays passthrough), a request for any
   active catalog id (`"model": "glm-5.1"`, `"model": "gpt-5.5"`, or another
   listed id) is served from managed supply with no per-model setup. For a
   keyless managed org, unknown ids return a clean catalog-miss 404 with
   available alternatives instead of falling through to unpriced provider
   passthrough. So a model sweep needs exactly one unrouted workload and can
   iterate over listed catalog ids in the request body.

   **Selecting the workload per request.** The gateway resolves which workload's
   route serves a request from two optional headers: `x-understudy-project`
   (project slug) and `x-understudy-workload` (workload name). Absent headers
   fall back to the org's default workload — whose route may rewrite the model.
   A bench harness should always send both headers and **never assume
   requested == served**: read the canonical legibility headers the gateway
   returns on every response — `x-understudy-mode` (managed/byo),
   `x-understudy-route` (`primary` / `understudy` / `fallback`), and
   `x-understudy-effective-model` (the public id that actually served) — and
   record the effective model, falling back to the response-body `model` field
   only if the headers are absent. Exclude runs where the requested and
   effective models disagree.

2. Route a workload to a model at a traffic percentage — a per-request split
   where that share goes to the routed model and the rest stays on passthrough.
   Pick a bounded share (e.g. 30%) to keep the comparison small.

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --model-id gemma-4-12b --traffic-pct 30
   ```

   Clearing the route (`--clear` in place of the model/traffic flags) returns the
   workload to full passthrough. The hosted split semantics are documented at
   [docs.understudylabs.com/concepts/routing](https://docs.understudylabs.com/concepts/routing).

3. Run the eval through the gateway so the routed model serves its share. Any
   local command works; an eval harness like a verifiers `vf-eval` run is typical.

   ```sh
   understudy run -- vf-eval <eval-id>
   ```

4. Prerequisite for a frontier comparison. For the split to compare the routed
   model against a frontier model, the non-routed (passthrough) share must have a
   configured managed provider key or BYO key; the managed catalog only resolves
   on no-route workloads. Without passthrough credentials, those non-routed
   requests error. For keyless accounts, use the **keyless catalog sweep** recipe
   first, then route only after choosing a candidate.

## Diagnostics

When the developer asks whether the gateway is causing errors, wants to check
provider health, or asks "is this us?", route to
[`../check-routing-health/SKILL.md`](../check-routing-health/SKILL.md). That
worker calls the read-only reporting endpoints (routing-status, provider-health,
compact status) and interprets the results. The full endpoint reference is at
[docs.understudylabs.com/reference/control-plane/reporting](https://docs.understudylabs.com/reference/control-plane/reporting).

## Output Standard

End with:

- auth status without revealing secrets;
- project/key readiness;
- model route status when configured;
- command run or blocked;
- whether provider calls or hosted execution were approved;
- local artifact path or next CLI command to monitor.

## References

- [`references/frontier-keys.md`](references/frontier-keys.md) — managed catalog
  vs BYO `.env` keys vs skip, the allowlisted env vars, the
  secret-to-remote-infra recipe, and the installer mapping.
- Hosted contracts on the docs site —
  [routing semantics](https://docs.understudylabs.com/concepts/routing),
  [capture](https://docs.understudylabs.com/concepts/capture), the
  [control-plane API](https://docs.understudylabs.com/reference/control-plane)
  behind `workloads`/`routes`/`captures`,
  [reporting & health](https://docs.understudylabs.com/reference/control-plane/reporting)
  for self-service diagnostics, and the gateway
  [request headers](https://docs.understudylabs.com/reference/request-headers) /
  [response headers](https://docs.understudylabs.com/reference/response-headers).

Domain depth in [`reference.md`](reference.md):

- **Trace capture** — gateway or local trace capture without changing the app
  interface; capture calls/prompts/responses/tool calls/latency/errors/tokens/
  metadata; redact; skip upload in local-only / restricted (ZDR) modes; produce a
  trace inventory (defer call-site discovery to
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)).
- **Deploy and compare** — reproducible baseline, smallest coherent route/config
  change that solves the measured cause via the workloads API (or a local
  `understudy.yaml`), rollback, comparison evals, before/after metrics, surfaced
  regressions.

For route selection and the fresh-pricing rule, see
[`../understudy/reference.md`](../understudy/reference.md); for measured claims,
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
