---
name: check-routing-health
description: Use when a developer asks "is Understudy causing my errors", "which workloads are routed", "is my routing config actually taking effect", "is my provider healthy", "are there 500s on staging", "what's our error rate", "where is my gateway spend going", or wants self-service diagnostics without asking the team. Reads the hosted reporting endpoints with the developer's sk_* key.
metadata:
  understudy:
    mode: interactive
    safety: read-only
    cli_required: true
---

# Check Routing Health

Use this worker when the developer wants to know whether Understudy routing is
causing errors, which workloads are routed, whether a declared route is really
taking effect, or where their gateway usage and spend goes. These are read-only
hosted endpoints that answer "is this us?" without asking the team.

Checked against existing skills: `use-understudy-gateway` owns auth, routing
setup, and route writes; `ramp-and-verify` owns production traffic changes.
This skill owns read-only diagnostic queries against the reporting surface and
does not write routes or change traffic.

## Safety Gates

These endpoints are read-only and carry no side effects. They do not change
routes, traffic percentages, or provider configuration. Do not print the full
`sk_*` key in output — mask it to the last 4 characters. Use `understudy run`
to inject credentials into child processes instead of pasting keys into shell
commands.

## Vocabulary — use these words, exactly

Everything you say to the user must use the canonical routing vocabulary:

- **Route outcomes** (`route_shares`): `primary` — the customer-requested
  model was served (includes catalog-by-name); `understudy` — an
  Understudy-configured route moved the traffic; `fallback` — a recovery
  re-issue after a routed attempt failed.
- **Declared config** (`declared`): `pin` | `steer` | `none`, plus the split
  percent (`split_pct`).
- **Provider labels**: `anthropic` | `openai` | `managed` — nothing else.
- A served model of `understudy-managed` is a managed model whose catalog
  mapping hasn't synced yet — a fail-closed placeholder, not an error.
- Never use "passthrough", "BYO", or "relay" in output to users. Older
  responses (the legacy `routing-status` endpoint) still emit some of these
  words — translate, don't echo.

## Prerequisites

The developer must be signed in (`understudy status --json` shows
`signed_in: true`) and have a project configured. If not, route to
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) for
auth setup first.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js status --json
```

## Flow

1. Confirm auth and project:

   ```sh
   understudy status --json
   ```

   Extract `org_id` and `project_slug` from the output. Resolve the project
   slug to a project id via `understudy projects list --json` if needed — the
   API path requires the `proj_...` id, not the slug. If not signed in, route
   to [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

2. **Ground in volume first.** Before analyzing or recommending anything, pull
   the usage summary and rank workloads by spend and request count:

   ```sh
   understudy run -- curl -s \
     -H "Authorization: Bearer \$UNDERSTUDY_API_KEY" \
     "https://api.understudylabs.com/admin/v1/orgs/\$UNDERSTUDY_ORG_ID/projects/<project-id>/usage-summary?window=7d&group_by=workload,day"
   ```

   Every statement you make must be grounded in that volume ranking — lead
   with the workloads that carry the spend and traffic. Do not anchor on
   low-leverage generic advice about workloads that barely run.

3. Pull the unified per-workload view:

   ```sh
   understudy run -- curl -s \
     -H "Authorization: Bearer \$UNDERSTUDY_API_KEY" \
     "https://api.understudylabs.com/admin/v1/orgs/\$UNDERSTUDY_ORG_ID/projects/<project-id>/workload-status?window=24h"
   ```

   One row per workload: `status` (healthy | degraded | idle), the declared
   config, observed `route_shares`, `rerouted_pct`, `served_models`,
   `error_rate`, and `example_request_ids`. Field details in
   [`reference.md`](reference.md).

4. Interpret, in priority order of the volume ranking from step 2:
   - `status: degraded` — the 5xx rate crossed the threshold. Check
     `served_models[].provider_label` to say which upstream is failing.
   - **Declared-vs-observed drift is a finding.** If `declared.split_pct > 0`
     but `route_shares.understudy` is ~0, tell the user plainly: their routing
     config is declared but not actually taking effect.
   - `rerouted_pct` (= `route_shares.understudy`) is THE number to watch
     during a ramp or cutover — compare it against `declared.split_pct`.
   - Non-zero `route_shares.fallback` means routed attempts are failing and
     being recovered — upstream instability on the routed arm.
   - Error rate above ~2% is worth investigating; a workload with
     `declared.routed: none` and errors is provider-side, not routing-caused.

5. If `example_request_ids` are present, offer to look them up:

   ```sh
   understudy captures get <request-id> --project <project>
   ```

6. If any call fails or a number looks wrong, capture the
   `x-understudy-request-id` response header and quote it when reporting the
   problem to the Understudy team — it is the join key on their side.

7. If issues are found and the developer wants to roll back, route to
   [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md) or clear the
   route immediately with `understudy routes clear <workload> --project <project>`.

The older `routing-status`, `provider-health`, and `status` endpoints still
exist but are deprecated — see the legacy section of
[`reference.md`](reference.md). Only fall back to them if `workload-status`
or `usage-summary` return 404 (an older deployment).

## Output Standard

End with:

- project/org context (without revealing the full key);
- the volume ranking (top workloads by spend/requests) that grounds the answer;
- per-workload status and any declared-vs-observed drift findings, in
  canonical vocabulary;
- the window queried and when the data was generated;
- recommended next action (investigate a request ID, adjust the window, roll
  back a route, or confirm healthy) — with any request ids quoted.

## References

- [`reference.md`](reference.md) — endpoint details, response shapes, field
  descriptions, and the deprecated legacy endpoints.
- [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
  auth setup, route writes, and gateway inference.
- [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md) — production
  ramp/rollback when diagnostics reveal a problem.
