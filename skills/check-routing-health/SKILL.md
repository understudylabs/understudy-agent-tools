---
name: check-routing-health
description: Use when a developer asks "is Understudy causing my errors", "which workloads are routed", "is my provider healthy", "are there 500s on staging", "what's our error rate", "check provider health", or wants self-service diagnostics without asking the team. Reads the hosted reporting endpoints with the developer's sk_* key.
metadata:
  understudy:
    mode: interactive
    safety: read-only
    cli_required: true
---

# Check Routing Health

Use this worker when the developer wants to know whether Understudy routing is
causing errors, which workloads are routed, or what the current provider health
looks like. These are read-only hosted endpoints that answer "is this us?"
without asking the team.

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

   Extract `org_id` and `project_slug` from the output. If not signed in, route
   to [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).

2. For a quick overview, call the compact status endpoint:

   ```sh
   understudy run -- curl -s \
     -H "Authorization: Bearer \$UNDERSTUDY_API_KEY" \
     "https://api.understudylabs.com/admin/v1/orgs/\$UNDERSTUDY_ORG_ID/projects/$PROJECT_ID/status?window=30m"
   ```

3. Print the `lines` array first — it is the dense human-readable summary.

4. If the developer needs details, call the individual endpoints
   (`routing-status`, `provider-health`) — see [`reference.md`](reference.md).

5. If `example_request_ids` are present, offer to look them up:

   ```sh
   understudy captures get <request-id> --project <project>
   ```

6. Interpret the results:
   - `error_5xx_rate` above ~2% is worth investigating.
   - Non-zero `timeout_count` or `fallback_count` indicates upstream instability.
   - `passthrough` workloads with errors are provider-side, not Understudy-caused.
   - `understudy` or `primary` workloads with errors may be route-related — check
     `provider_label` and `model` to identify the upstream.

7. If issues are found and the developer wants to roll back, route to
   [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md) or clear the
   route immediately with `understudy routes clear <workload> --project <project>`.

## Output Standard

End with:

- project/org context (without revealing the full key);
- compact status lines or the specific diagnostic answer;
- whether any workloads show elevated error rates;
- the window queried and when the data was generated;
- recommended next action (investigate a request ID, adjust the window, roll
  back a route, or confirm healthy).

## References

- [`reference.md`](reference.md) — endpoint details, response shapes, field
  descriptions, and the individual routing-status and provider-health surfaces.
- [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
  auth setup, route writes, and gateway inference.
- [`../ramp-and-verify/SKILL.md`](../ramp-and-verify/SKILL.md) — production
  ramp/rollback when diagnostics reveal a problem.
