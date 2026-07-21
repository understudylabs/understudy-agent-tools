# Management migration — honest gap list

All eleven inventory surfaces are ported and enabled in nav:
org-summary-dashboard, org-analytics-reporting, project-summary,
project-reporting, workload-configuration, captures-list-and-detail,
api-keys, models, billing, setup, settings.

What did NOT come over, or came over with known limits:

## Credentials / org resolution (systemic)

- Signed-in-but-multi-org credentials: creds.rs only yields org_id when the
  orgs map has exactly one entry (legacy top-level keys carry no org id), so
  admin_get fails with org_unknown for multi-org users — desktop needs an org
  selector or the CLI to stamp an active org id. Every pane that resolves an
  org (org reporting, settings, billing, api-keys, captures) shows its own
  "no active organization / re-run `understudy login`" notice instead of an
  org picker; a proper picker needs new plumbing.
- sk_ requests carry no user identity. Fine for the read-only panes, but:
  - WorkOS audit logs will attribute key create/revoke to the keyId, not a person.
  - any future mutation surface behind requireFreshToken/userId (Setup key
    minting, catalog mutations) needs a WorkOS JWT path the desktop app
    does not have.
- sk_ keys cannot satisfy requireFreshToken mutations, so surfaces built on
  those handlers are strictly view-only by construction (matches the web
  pages' intent; no auth hole).

## Live gateway contract gaps (probed with the real sk_ key)

- customer/v1 routes reject sk_ keys (live-verified): GET
  /customer/v1/orgs/:org/projects/:pid/workloads returns authentication_error
  "This endpoint only accepts WorkOS AuthKit access tokens." This blocks
  listWorkloadCaptures, getCapture, and getWorkloadCapture equivalents —
  only the project-aggregate captures list (admin/v1 .../captures, verified
  200) works today. Workload-filtered lists and every capture detail surface
  that gateway error until admin/v1 grows equivalents or customer/v1 accepts sk_.
- admin/v1 has no capture-detail route: .../captures/:request_id → 404 and
  .../workloads/:wid/captures{,/rid} → 404 (probed live). Capture detail is
  currently impossible with the desktop credential regardless of client code.
- listSupportedModels endpoint gap: GET /admin/v1/orgs/:org/models exists at
  platform origin/main (model_routes.ts) but live prod returns "Path not
  found" (verified 2026-07-20). setup_info treats it as non-fatal and Setup
  shows "No catalog models yet" — managed-mode snippets are effectively
  unavailable until the platform deploys that route. (The Models pane's own
  read of the same path was separately live-verified returning 14 models in
  an earlier session; treat the discrepancy as deploy-lag to re-probe.)
- Workload create/update mutations go through the customer/v1 mount whose
  handlers use requireFreshToken per the platform inventory — an sk_ key may
  be rejected. Implemented anyway; gateway errors surface verbatim in the
  New-workload dialog. Untested against the live API.
- Routing writes (PATCH admin/v1 .../workloads/:wid) and capture toggle
  (PATCH customer/v1 ...) were verified in origin/main admin-api source to
  NOT require requireFreshToken, so sk_ should work — but neither mutation
  was live-tested against production in this run (reads were).
- billing_topup_checkout with an sk_ key is untested live (money path). The
  admin-api billing routes show no requireFreshToken/userId gate, but if the
  platform later tightens mutations the desktop top-up breaks; reads are
  unaffected.
- API-keys create/revoke were verified against admin-api source (adminAuth
  only), but only reads were live-verified — first real create/revoke from
  the app is worth a smoke test.

## Verification honesty

- No live end-to-end run of the integrated app against the gateway was
  performed from this worktree; endpoint shapes come from the live-verified
  inventory and admin-api source. Rust-side coverage is unit-level
  (error-envelope mapping, path validation, routing-patch invariants); the
  HTTP paths themselves are untested against a mock server.
- request-id copy uses navigator.clipboard, which needs the Tauri clipboard
  permission if the webview denies it (untested in packaged app).

## Deliberate drops / deferrals

- GettingStartedCard.tsx was listed as a source but is orphaned on
  origin/main (imported nowhere) — deliberately not ported.
- PostHogIdentity from the web pages has no desktop equivalent (telemetry is
  opt-in here) and was dropped.
- Onboarding handoff channel intentionally dropped (the cookie minted by web
  signup has no desktop-native equivalent; the desktop key is already durable
  in credentials.json). A web-signup→app deep link needs a new channel
  (custom URL scheme or file drop).
- org-scope ReportingClient (661 LOC near-duplicate of the project one) not
  ported/unified — the org Analytics pane is its own faithful port; unifying
  the two clients is deferred.
- loading.tsx's PageSkeleton was not ported as a component; panes use the
  app's existing inline "Loading…" card convention.
- Web Quickstart sk_ paste: kept paste-only; the signed-in key is never
  prefilled into snippets, only its 4-char suffix as a hint.

## Fidelity deltas (data-identical, presentation differs)

- Recharts is not a dependency of the desktop app, so charts are hand-rolled
  stacked bars (flex columns + title tooltips) — visually traditional and
  data-identical, but no hover crosshair/animated tooltip.
- Chart palette: desktop globals.css has no --color-chart-1..5 tokens; mapped
  to the canonical model colors (clay/mint/amber/violet/cyan) per the design
  doctrine.
- workload-status has no "failing" state on the wire (healthy|degraded|idle)
  while the app's health-dot CSS expects healthy|degraded|failing|unknown;
  idle/undefined map to the muted "unknown" dot. The ScopeSwitcher's
  "failing" vocabulary has no gateway counterpart and is never emitted.
- capture_sample_rate is displayed and validated but has no editor control —
  faithful to the web WorkloadConfigClient, which also only toggles
  capture_enabled.
- Aamir's project capture list is ascending R2 order ("Next page") vs
  workload lists newest-first ("Older captures") — preserved verbatim; the
  desktop's Newer/Older cursor stack means the project aggregate pages
  oldest-first like the web did. Flagging in case founders expected
  newest-first everywhere on desktop.
- The web Models page's "Catalog models — see the Models page" hint text is
  kept verbatim; slightly aspirational copy given the desktop split between
  catalog and local models.
- The web Models page's "Route a workload instead" button linked to
  /projects; kept text-only per the no-dead-links rule (project Routing as a
  standalone view is the workload Configuration pane here).
- Stripe Checkout success/cancel URLs are server-set to
  APP_BASE_URL/dashboard/billing?topup=..., so after paying the browser lands
  on the web dashboard, not the desktop app. The pane compensates by polling
  the balance; a real desktop return needs a custom URL scheme deep link or
  an admin-api param to override the return URLs.
- Top-up success detection is heuristic: balance_usd strictly increasing
  within ~3 minutes. Concurrent spend that outpaces the credit, or a slow
  webhook, silently drops back to idle with no explicit failure signal (no
  topup-status endpoint exists to poll instead).
- Org settings identity gap: sk_ keys carry no WorkOS user, so the web
  page's email/name/user-id fields cannot be shown; the desktop Account card
  shows org id / auth mode / key suffix instead.
- Workloads-count badge on the web IdentityCard is omitted where the count
  would be derived from a source the desktop cannot see truthfully.
- Web rename/delete revalidated /dashboard via revalidatePath; the desktop
  equivalent is a local projects re-fetch only — other panes won't see a
  rename/delete until their own refresh.

## Scope plumbing / performance

- workloads_list health does one workload-status call per project
  (sequential); fine for a handful of projects, would need batching for
  large orgs. reporting/options carries no per-workload health, so any
  switcher health dots from that source render "unknown".
- (Resolved during integration, noted for history: the ScopeSwitcher's
  projects_list/workloads_list Rust stubs were replaced with real admin/v1
  reads by the workload-configuration branch; earlier per-surface notes that
  they "still return empty lists" no longer apply on this branch.)

## Nav / doctrine deviations

- Deliberate desktop-only nav addition: manage-models previously pointed at
  the local ModelsPane; it now points at the ported catalog and a "Local
  models" row keeps the native library reachable — flagged since the
  doctrine says port the nav verbatim.
- Integration addition: the project-scoped Analytics port and the org
  Analytics port both arrived named ReportingPane on pane id "reporting";
  the project one was renamed ProjectReportingPane on pane id
  "project-reporting" with a new "Project Analytics" nav row, and its CSS
  namespace moved to .projrep-* to avoid colliding with the org pane's
  .reporting-* classes.

## Upstreamable bugs found during the port

- Web billing page float bug: AddCreditCard's whole-cent check
  (Math.round(c*100) !== c*100) rejects valid amounts like $10.05 due to
  binary float noise; the desktop port fixes it with an epsilon.

## Housekeeping

- package-lock.json changed slightly from the required `npm install` in the
  fresh worktrees; included in the commits to keep the tree clean — drop if
  the parent branch manages the lockfile separately.
