# Check Routing Health — Reference

Endpoint details and response shapes for the self-service reporting endpoints.
Full hosted reference at
[docs.understudylabs.com/reference/control-plane/reporting](https://docs.understudylabs.com/reference/control-plane/reporting).

All endpoints are `GET` requests authenticated with the developer's `sk_*` key
under `https://api.understudylabs.com/admin/v1/orgs/:org_id/...`.
Every response (success or error) carries an `x-understudy-request-id` header —
quote it when reporting a problem to the Understudy team.

The two primary project-scoped endpoints are **workload-status** (per-workload
health, declared vs observed routing) and **usage-summary** (tokens/cost/cache
over longer windows). The `sk_*` surface also serves
[organization reporting](#organization-reporting) (org-wide usage/cost series
across projects) and a [captures metadata list](#captures-metadata-list)
(concrete request ids to hand the Understudy team). The three older endpoints
are deprecated — see [Legacy endpoints](#legacy-endpoints-deprecated).

## Vocabulary

All responses use the canonical vocabulary — use the same words with the user:

- Route outcomes: `primary` (customer-requested model served, includes
  catalog-by-name), `understudy` (an Understudy-configured route moved the
  traffic), `fallback` (recovery re-issue after a routed attempt failed).
- Declared config: `pin` | `steer` | `none` + `split_pct` (0–100).
- Provider labels: `anthropic` | `openai` | `managed`. `managed` means served
  by Understudy's serving infrastructure; no other provider names appear.
- `understudy-managed` as a served model = a managed model whose catalog
  mapping hasn't synced yet (fail-closed placeholder, not an error).
- Never say "passthrough", "BYO", or "relay" to users.

## Workload status

```
GET .../workload-status?window=24h
```

The unified per-workload view: declared routing config joined server-side with
observed traffic, so you never reconcile routing topology against health
metrics by hand.

| Param | Default | Details |
|---|---|---|
| `window` | `24h` | Lookback window. Accepts `30m`, `1h`, `6h`, up to `24h`. |

```sh
understudy run -- sh -c 'curl -s \
  -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/<org-id>/projects/<project-id>/workload-status?window=24h"'
```

The `sh -c` wrapper is required: `understudy run` spawns the child without a
shell, so `$UNDERSTUDY_API_KEY` only expands inside the child shell.

```jsonc
{
  "project_id": "proj_...",
  "window": "24h",
  "window_start": "2026-07-19T18:00:00.000Z",
  "window_end": "2026-07-20T18:00:00.000Z",
  "workloads": [
    {
      "workload_id": "usp_...",
      "display_name": "chat",
      "status": "healthy",                  // "healthy" | "degraded" | "idle"
      "mode": "anthropic",                  // dominant provider label; null when idle
      "declared": { "routed": "pin", "split_pct": 30 },
      "requests": 1200,
      "route_shares": { "primary": 0.71, "understudy": 0.28, "fallback": 0.01 },
      "error_rate": 0.0025,
      "last_error_at": "2026-07-20T17:42:12.000Z",
      "example_request_ids": ["0190a7c2-7e11-7cc3-a312-9f1b22d40e88"],
      "served_models": [
        { "model": "glm-5.1", "provider_label": "managed", "requests": 336, "share": 0.28 },
        { "model": "claude-haiku-4-5", "provider_label": "anthropic", "requests": 864, "share": 0.72 }
      ],
      "rerouted_pct": 0.28
    }
  ],
  "workload_count": 1,
  "generated_at": "2026-07-20T18:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `status` | `healthy` — traffic in window, error rate below the degraded threshold. `degraded` — 5xx rate at/above threshold. `idle` — no traffic in the window. |
| `mode` | Dominant provider label in the window (`anthropic` \| `openai` \| `managed`); per-slice truth is `served_models[].provider_label`. `null` when idle. |
| `declared` | Routing config as configured: `routed` is `pin` (route pinned to a deployment), `steer` (route steered to a model), or `none` (no Understudy route — traffic is `primary`, models served as requested). `split_pct` is the traffic dial; 0 when `none`. |
| `route_shares` | Observed request shares by route outcome, each 0..1: `primary`, `understudy`, `fallback`. Very old windows may sum below 1 (pre-vocabulary rows land in no bucket). |
| `rerouted_pct` | Share of requests moved by an Understudy-configured route (= `route_shares.understudy`). THE number to watch during a ramp/cutover. Deliberately not a served-vs-requested model diff — catalog-by-name rewrites the served model while staying `primary`. |
| `served_models[]` | Per-model slices: `model`, `provider_label`, `requests`, `share` (0..1 of the workload's requests). |
| `error_rate` | 5xx error rate over the window (0..1). |
| `example_request_ids` | Request ids from failing requests. Look up via `understudy captures get <request-id>` or quote to the team. |

**Drift check (always run it) — normalize units first.** `declared.split_pct`
is a 0–100 dial; `route_shares.understudy` and `rerouted_pct` are 0..1 shares.
Compare `split_pct / 100` against the share, never the raw numbers: declared
`30` with observed `0.28` is a healthy ramp, not drift. Flag drift when
`split_pct / 100 − route_shares.understudy` exceeds ~0.1; `split_pct > 0` with
an observed share of ~0 means the declared route is not actually taking effect
— that is a finding to surface, not noise.

**Error attribution:** `served_models[]` carries request counts/shares only —
no per-provider error counts — so a degraded workload's 5xxs cannot be pinned
on a provider from traffic labels. Report the workload-level `error_rate` plus
`example_request_ids` and leave provider attribution to the Understudy team.

## Usage summary

```
GET .../usage-summary?window=7d&group_by=workload,day
```

Aggregate-only tokens/cost/cache rollup — no per-request ids, which is why it
accepts longer windows than the other endpoints. Use it first to rank
workloads by spend/requests and ground the rest of the diagnosis.

| Param | Default | Details |
|---|---|---|
| `window` | `7d` | Accepts `6h`, `24h`, `7d`, up to `30d`. |
| `group_by` | — | Comma-separated subset of the server-side allowlist: `workload`, `model`, `day`. |

```sh
understudy run -- sh -c 'curl -s \
  -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/<org-id>/projects/<project-id>/usage-summary?window=7d&group_by=workload,day"'
```

```jsonc
{
  "project_id": "proj_...",
  "window": "7d",
  "window_start": "2026-07-13T18:00:00.000Z",
  "window_end": "2026-07-20T18:00:00.000Z",
  "group_by": ["workload", "day"],
  "groups": [
    {
      "workload_id": "usp_...",
      "workload": "chat",                   // display name; null unless grouped by workload
      "model": null,                        // set when grouped by model
      "day": "2026-07-19",                  // UTC YYYY-MM-DD; set when grouped by day
      "requests": 4100,
      "input_tokens": 9600000,
      "output_tokens": 410000,
      "cache_read_input_tokens": 3900000,
      "cache_creation_input_tokens": 220000,
      "cache_read_pct": 0.41,               // share of prompt tokens served from cache
      "customer_cost_usd": 12.84,
      "error_rate": 0.001
    }
  ],
  "generated_at": "2026-07-20T18:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `groups[]` | One row per group-by combination. Ungrouped dimensions are `null`. |
| `cache_read_pct` | `cache_read_input_tokens` over prompt tokens (0..1). Low values on a cacheable workload are a savings lead. |
| `customer_cost_usd` | What the customer is billed for the group over the window. Rank workloads by this + `requests` before making any recommendation. |
| `error_rate` | 5xx error rate within the group (0..1). |

## Organization reporting

```
GET /admin/v1/orgs/:org_id/reporting?window=7d&group_by=project
GET /admin/v1/orgs/:org_id/reporting/options
```

Org-wide usage and customer-cost series across all projects — the rollup for
"which project is the spend in" before drilling into a project's
usage-summary. Usage and cost only: it deliberately carries no workload
health (that stays on workload-status).

| Param | Default | Details |
|---|---|---|
| `window` | `7d` | `24h`, `7d`, or `30d` — or instead pass `from`/`to` as inclusive UTC dates (`YYYY-MM-DD`), up to 366 days. |
| `granularity` | — | `minute` (ranges up to 24h), `hour` (up to 31d), `day` (up to 366d). |
| `group_by` | — | ONE of `project`, `workload`, `model` (single value, unlike usage-summary). |
| `project_id`, `workload_id` | — | Optional filters. |

```sh
understudy run -- sh -c 'curl -s \
  -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/$UNDERSTUDY_ORG_ID/reporting?window=7d&group_by=project&granularity=day"'
```

The response carries `totals` (`requests`, `input_tokens`, `output_tokens`,
`total_tokens`, `customer_cost_usd`) plus a `series` of time-bucket points
(`bucket` ISO start + the group's `project`/`workload`/`model` labels + the
same measures). `/options` returns the org's projects and workloads
(`{id, name}` / `{id, project_id, name}`) for valid filter values. Model
labels are the same customer-safe labels as everywhere else.

## Captures metadata list

```
GET /admin/v1/orgs/:org_id/projects/:project_id/captures?limit=25&cursor=...
```

Recent capture **metadata** for a project — the way to collect concrete
request ids to hand the Understudy team when `example_request_ids` is empty
or you need more. Each item is listing metadata only: `key`, `size`,
`uploaded`, `request_id`, `workos_org_id`, `workos_api_key_id`. `limit`
defaults to 25 (max 100); `truncated: true` comes with an opaque R2 `cursor`
to pass back verbatim for the next page.

```sh
understudy run -- sh -c 'curl -s \
  -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/$UNDERSTUDY_ORG_ID/projects/<project-id>/captures?limit=25"'
```

Capture **content** (request/response bodies) is not readable with an `sk_*`
key — it stays behind the dashboard login. The dashboard-side capture surface
(including its per-request detail view and the workload-scoped list that
reports `skipped_malformed` and `scanned_through` scan progress) accepts only
signed-in user tokens and rejects `sk_*` outright, so do not present those as
agent-callable.

## Error responses

| Status | Type | When |
|---|---|---|
| 400 | `invalid_request_error` | Invalid `window` (max `24h` on workload-status, `30d` on usage-summary) or `group_by` outside the `workload`/`model`/`day` allowlist. Organization reporting validates its own `window`/`from`–`to`, `granularity`, and single-value `group_by` the same way — each 400 message names the accepted values. |
| 401 | `authentication_error` | Missing or invalid `sk_*` key. |
| 404 | `not_found_error` | Project not found or does not belong to the caller's org. Also what an older deployment returns for the two new endpoints — fall back to the legacy endpoints below. |
| 500 | `internal_error` | Upstream query failure; retry after a moment. |

Every error envelope carries `request_id`, and every response carries the
`x-understudy-request-id` header — quote it when escalating.

## Calling without the CLI

The endpoints accept a standard `Authorization: Bearer sk_*` header. Prefer
`understudy run -- sh -c '...'` so credentials come from the CLI's credential
store (see the examples above). To call curl directly instead, first export
the key from `~/.understudy/credentials.json` in your own shell — the variable
below expands in *your* shell, not via `understudy run`:

```sh
curl -s -H "Authorization: Bearer $UNDERSTUDY_API_KEY" \
  "https://api.understudylabs.com/admin/v1/orgs/$ORG_ID/projects/<project-id>/workload-status?window=6h"
```

## Legacy endpoints (deprecated)

Older deployments may still rely on these three endpoints; they remain
available but are superseded by `workload-status` + `usage-summary`. Do not
use them when the new endpoints respond. Their vocabulary predates the
canonical route words — translate before speaking to the user, never echo
`route_mode` values verbatim.

### Routing status

```
GET .../routing-status
```

Per-workload declared routing topology only (no observed traffic). Carries a
legacy `route_mode` enum that is off-vocabulary: it labels a 100%-routed
workload `primary` and a no-route workload `passthrough` — canonically that
traffic is `understudy` and `primary` respectively. Prefer
`workload-status`'s `declared` object. `provider_label` and `model` are
scrubbed to the same labels as everywhere else (`anthropic` | `openai` |
`managed`; managed models may read `understudy-managed`).

### Provider health

```
GET .../provider-health?window=30m
```

Error/health metrics aggregated by provider label, workload, and model:
`request_count`, `error_5xx_count`, `error_5xx_rate`, `timeout_count`,
`fallback_count`, `last_failing_at`, `example_request_ids` (up to 5). Window
default `30m`, max `24h`. Superseded by `workload-status`, which joins these
metrics with the declared config.

### Compact status

```
GET .../status?window=30m
```

Combines routing-status and provider-health into human-readable `lines` plus
both structured payloads nested as `routing` and `health`. The `lines` text
uses the legacy vocabulary — rewrite it in canonical words before showing it.
