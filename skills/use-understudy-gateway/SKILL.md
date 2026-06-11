---
name: use-understudy-gateway
description: Use when a developer wants authenticated Understudy inference, project/key management, public model routing, gateway-backed local commands, or durable CLI execution that an agent can monitor.
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
management, workload route configuration, hosted execution, or an authenticated
cookbook.

## Safety Gates

Do not ask the developer to paste an API key. Use the CLI registration flow and
let the CLI store credentials outside the repo.

Do not print, commit, or write `sk_*` values into artifacts. `understudy run`
injects `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL` only into the child
process environment.

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

2. If not signed in, register/sign in with the email-code flow:

   ```sh
   understudy login --email <developer-email>
   ```

   This creates or finds the developer's Understudy account, retrieves an API
   key through the CLI, and stores it outside the repo. The key is used for
   authenticated gateway inference, project/key management, and remote model
   routes. Do not ask the developer to paste the key.

   An agent with an approved native email connector may search narrowly for the
   fresh sign-in email and enter the one-time code into the waiting CLI prompt.
   Do not print or persist the code.

3. Confirm project/key readiness:

   ```sh
   understudy projects list --json
   understudy keys list --json
   ```

4. For frontier-vs-Understudy A/B routing, list public model IDs and set a
   bounded workload route — see the **A/B model routing** recipe below for the
   commands and the split mechanics. The agent must not expose or ask for
   supplier/provider details; the app keeps calling the normal gateway path while
   the control-plane route decides the split.

5. Run the local command through the gateway wrapper only after approval:

   ```sh
   understudy run -- <local command>
   ```

6. Monitor the command output and local artifacts. For optimization work, route
   back to [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) once
   the run has produced candidate/proof evidence.

## A/B model routing

Use this recipe to A/B a chosen public model against passthrough while an eval
runs through the gateway. A typical consumer is
[`../optimize-agentic-search/SKILL.md`](../optimize-agentic-search/SKILL.md),
comparing a workload's quality and cost across the split.

1. Discover public model options (public model IDs only; no supplier detail):

   ```sh
   understudy models list --json
   ```

   The list is the remote ladder. It should include larger Gemma-family routes
   when enabled for the account, so the same API key can graduate a workload from
   the local Gemma 4 E2B first rung to larger Gemma variants or remote/hybrid
   routes without changing application code.

2. Route a workload to a model at a traffic percentage — a per-request split
   where that share goes to the routed model and the rest stays on passthrough.
   Pick a bounded share (e.g. 30%) to keep the comparison small.

   ```sh
   understudy workloads route <workload-id> --project-id <project-id> --model-id gemma-4-12b --traffic-pct 30
   ```

   Clearing the route (`--clear` in place of the model/traffic flags) returns the
   workload to full passthrough.

3. Run the eval through the gateway so the routed model serves its share. Any
   local command works; an eval harness like a verifiers `vf-eval` run is typical.

   ```sh
   understudy run -- vf-eval <eval-id>
   ```

4. Prerequisite for a frontier comparison. For the split to compare the routed
   model against a frontier model, the non-routed (passthrough) share must have a
   configured managed frontier; without it those requests error. This is usually
   account setup, not a per-run flag, so confirm it before starting an A/B —
   otherwise only the routed share returns results.

## Output Standard

End with:

- auth status without revealing secrets;
- project/key readiness;
- model route status when configured;
- command run or blocked;
- whether provider calls or hosted execution were approved;
- local artifact path or next CLI command to monitor.

## References

Domain depth in [`reference.md`](reference.md):

- **Trace capture** — gateway or local trace capture without changing the app
  interface; capture calls/prompts/responses/tool calls/latency/errors/tokens/
  metadata; redact; skip upload in local-only / restricted (ZDR) modes; produce a
  trace inventory (defer call-site discovery to
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md)).
- **Deploy and compare** — reproducible baseline, smallest route/config change
  via the workloads API (or a local `understudy.yaml`), rollback, comparison
  evals, before/after metrics, surfaced regressions.

For route selection and the fresh-pricing rule, see
[`../understudy/reference.md`](../understudy/reference.md); for measured claims,
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
