# Shipping "Explore Data" — Moraine viewer → understudy-desktop

**Status:** plan v1 — 2026-07-20 (branch rebased onto main @ desktop 0.3.32)
**Prototype:** `apps/moraine-viewer` (Next 16, standalone). **Target:** `apps/homescreen` (Tauri + Next 15 static export).

## Product shape

Left-hand nav gains a top-level section switcher: **Chat | Explore Data**.
Explore Data's hero is your local trace history (Moraine, headless underneath):
timeline → search → transcript → tasks → measured model comparisons. The
existing chat sidebar remains the Chat section's rail; Explore gets its own
internal sub-nav (timeline / tasks / session — the reference mocks stay
prototype-only).

Jobs-to-be-done coverage in the app:
1. Awareness — timeline pane (lanes, live pulse, commit strip, ingest health).
2. Retrieval — search + fly-to + full transcript (live tail).
3. Self-knowledge — task clusters; in-app "understand my history" scan job.
4. Economics — tasks catalog + measured evals (leaderboard treemap later).
5. Action — routing hooks into existing route_policy.rs (post-MVP).

## The one hard constraint (from recon)

`apps/homescreen` is **`output: "export"`** — static files in a WKWebView, no
Node runtime in production. The prototype's 13 API routes (ClickHouse fetches +
`node:sqlite` reads) cannot ship as-is. **All data access moves to Rust**:

- New `src-tauri/src/explore.rs` with Tauri `invoke` commands:
  - `explore_clickhouse_query(sql)` — `reqwest` → `127.0.0.1:8123`, enforcing
    the same guardrails as `lib/clickhouse.ts` (SELECT/SHOW/DESCRIBE only,
    2GB/4-thread/30s caps, db=moraine).
  - `explore_scan_meta()`, `explore_commits(day?)`, `explore_langs(session?)`,
    `explore_tasks()`, `explore_benchmark(slug)`, `explore_evals(slug)` —
    `rusqlite` (already in Cargo.toml) over the explore data dir.
- Frontend gets a thin `lib/exploreData.ts` adapter: same function signatures
  the components already call, implemented via `invoke()` instead of `fetch()`.
  The 13 route handlers' SQL/aggregation logic ports nearly 1:1 (it's all
  query-building + JSON shaping).
- Why invoke over axum-:17790: matches the GUI's existing all-invoke pattern,
  no bearer-token plumbing in the webview, and keeps :17790 an agent surface.
  (Agent-facing explore endpoints on :17790 come later with the Understudy MCP
  story — same Rust helpers, two frontends.)

## Data home

Scanner outputs move from `apps/moraine-viewer/data/*.sqlite` to
**`~/.understudy/explore/`** (scan.sqlite, commits.sqlite, langs.sqlite,
benchmarks/, evals/). Both the prototype scripts and the Rust readers point
there (env override for dev). Not bundled app resources — this is
user-generated data.

## Scan pipeline in the app

The scanner/cluster/commits scripts are bun scripts today. Path to app-managed:
- MVP: Explore shows "no scan data yet" with a copyable CLI invocation
  (`understudy explore scan` — port scripts into the agent-tools CLI, which
  is already bundled with the app via `build-desktop-cli.mjs`).
- v2: a "scan my history" button — Rust spawns the bundled CLI as a managed
  job (same pattern as residency.rs model servers), pointing at an
  app-resident model (residency already serves MLX models — the scanner's
  `SCAN_LLM_URL` just targets the app's own server instead of ad-hoc :8877).

## Phases

### Phase A — Explore pane MVP (timeline + transcript)  [~2-3 sessions]
1. Deps: add `three`, `@react-three/fiber`, `@react-three/drei` to homescreen
   (React 19 ✓; coexists with rive-webgl2; verify static export bundle size).
2. Tokens: merge the viewer's `--model-*` palette + `--field/--rule` names
   into homescreen globals (values already agree on card/ink/stamp/hover).
3. Nav: `PaneId` gains `"explore"`; a slim section switcher (Chat | Explore
   Data) above the chat rail; Explore pane hosts internal sub-nav (flatten
   the viewer's Next routes into component view-state — no Next routing).
4. Rust: `explore.rs` commands (clickhouse proxy + sqlite readers) +
   `exploreData.ts` adapter; port timeline (+search, live poll, commit strip,
   health line) and the transcript view (live tail).
5. Moraine dependency UX: `moraine.rs` already manages `moraine up/status`;
   Explore's empty state drives Moraine install/start from within the app.
6. Gate: `bun run build` (static export) green; app runs with the pane fully
   functional against live local Moraine; existing gates+rust CI green.

### Phase B — full JTBD surface  [~2 sessions]
7. Port tasks catalog (+ benchmark drafts/evals readers) and anatomy.
8. Scan pipeline: scripts → agent-tools CLI subcommands; data dir move;
   "scan my history" empty-state CTA (CLI invocation first, managed job
   after).
9. Leaderboard treemap with measured rows (needs eval files present).
10. `server-focus` event support for `explore` (Rust/agents can deep-link).

### Phase C — release  [1 session]
11. Version bump (package.json + tauri.conf.json + Cargo.toml in lockstep),
    PR → main, gates + rust green.
12. `desktop-release.yml` validate → release (DMG, notarize, updater tarball,
    latest.json). Rides the existing 0.3.x updater train — existing users get
    Explore Data on next update.
13. Follow-through: profile WebGL in WKWebView on Intel/low-RAM Macs;
    plumbing-quarantine defaults verified on fresh installs (users without
    CodexBar noise); docs + product-knowledge skill update.

## Risks / open questions
- WKWebView WebGL perf vs Chromium (shader points are cheap; verify additive
  blending + DPR handling on Safari engine early in Phase A).
- Next 15 vs 16: viewer components are client-only and should port; any Next-16
  ism surfaces immediately at static build. (Prototype stays on 16 as the fast
  dev harness — HMR-speed iteration remains there per the original decision.)
- Moraine not installed / not running: Explore must degrade to a guided
  install state, not a blank pane (moraine.rs gives us status probing).
- CSP is currently null; do NOT rely on webview→:8123 direct fetch — all data
  through Rust so tightening CSP later costs nothing.
