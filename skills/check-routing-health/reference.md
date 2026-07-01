# Check Routing Health — Reference

Endpoint details and response shapes for the three self-service reporting
endpoints. Full hosted reference at
[docs.understudylabs.com/reference/control-plane/reporting](https://docs.understudylabs.com/reference/control-plane/reporting).

All three are `GET` requests authenticated with the developer's `sk_*` key at
`https://api.understudylabs.com/admin/v1/orgs/:org_id/projects/:project_id/...`.

## Routing status

```
GET .../routing-status
```

Returns per-workload routing topology: which workloads route through Understudy,
at what traffic percentage, which provider and model are active, and when the
route was last changed.

```jsonc
{
  "project_id": "proj_...",
  "workloads": [
    {
      "workload_id": "usp_...",
      "display_name": "chat",
      "environment": null,
      "route_mode": "understudy",       // "primary" | "understudy" | "passthrough"
      "active_traffic_pct": 30,
      "provider_label": "fireworks",
      "model": "llama-3.3-70b",
      "updated_at": "2026-06-30T00:00:00Z"
    }
  ],
  "workload_count": 2,
  "generated_at": "2026-06-30T18:30:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `route_mode` | `primary` — 100% routed. `understudy` — 1–99% canary. `passthrough` — BYO, no routing. |
| `active_traffic_pct` | 0–100. Percentage of matching requests routed to the managed model. |
| `provider_label` | Public upstream provider name (e.g. fireworks, anthropic). null when passthrough. |
| `model` | Catalog model id the route targets. null when passthrough. |

## Provider health

```
GET .../provider-health?window=30m
```

Returns recent error and health metrics aggregated by provider, workload, and
model.

| Param | Default | Details |
|---|---|---|
| `window` | `30m` | Lookback window. Accepts `30m`, `1h`, `6h`, up to `24h`. |

```jsonc
{
  "project_id": "proj_...",
  "window": "30m",
  "window_start": "2026-06-30T18:00:00.000Z",
  "window_end": "2026-06-30T18:30:00.000Z",
  "total_requests": 1200,
  "total_errors": 11,
  "providers": [
    {
      "provider": "anthropic",
      "workload": "chat",
      "model": "claude-haiku-4-5",
      "request_count": 600,
      "error_5xx_count": 11,
      "error_5xx_rate": 0.0183,
      "timeout_count": 2,
      "fallback_count": 8,
      "last_failing_at": "2026-06-30T18:28:12.000Z",
      "example_request_ids": [
        "0190a7c2-7e11-7cc3-a312-9f1b22d40e88",
        "0190a7c2-8a22-7cc3-b413-1a2c33e51f99"
      ]
    }
  ],
  "generated_at": "2026-06-30T18:30:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `error_5xx_rate` | error_5xx_count / request_count, rounded to four decimal places. |
| `timeout_count` | Requests where the upstream timed out and triggered a fallback. |
| `fallback_count` | Total requests that fell back to an alternative route for any reason. |
| `example_request_ids` | Up to 5 request IDs from failing requests in the window. Look up via [captures](https://docs.understudylabs.com/reference/control-plane/captures) or `x-understudy-request-id` in logs. |

## Compact status

```
GET .../status?window=30m
```

Combines routing topology and provider health into human-readable `lines` plus
the full structured data. The `lines` array is the quick answer:

```text
chat: 30% routed through Understudy / fireworks (llama-3.3-70b)
  Last 30m: 11 provider 500s, 1.83% error rate
automation: passthrough (BYO)
```

The nested `routing` and `health` objects carry the same data as the individual
endpoints. The optional `?window=` param works the same as on provider-health
(default `30m`, max `24h`).

## Calling without the CLI

The endpoints accept a standard `Authorization: Bearer sk_*` header. Use
`understudy run` to inject credentials from the CLI's credential store:

```sh
understudy run -- curl -s \
  -H "Authorization: Bearer \$UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/\$UNDERSTUDY_ORG_ID/projects/<project-id>/routing-status"
```

Or call directly with the key from `~/.understudy/credentials.json`:

```sh
curl -s -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/$ORG_ID/projects/<project-id>/provider-health?window=1h"
```

## Error responses

| Status | Type | When |
|---|---|---|
| 400 | `invalid_request_error` | Invalid `window` param (not a recognized duration or exceeds 24h). |
| 401 | `authentication_error` | Missing or invalid `sk_*` key. |
| 404 | `not_found_error` | Project not found or does not belong to the caller's org. |
| 500 | `internal_error` | ClickHouse or D1 query failure; retry after a moment. |
