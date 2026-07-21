# Moraine Viewer → Personalized Benchmarks: Roadmap

**Status:** draft v1 — 2026-07-19
**Owner:** Luis
**Branch:** `lluisinthedesert/moraine-webgl`

## Vision

Understudy becomes the layer of abstraction *above* Moraine (which is itself the
layer above ClickHouse). Moraine is used for exactly one thing: its high-quality,
lossless, multi-harness trace capture. Everything above that — exploration,
documentation of your work history, task discovery, personalized benchmarks,
model recommendations, and eventually routing — is Understudy.

The story: *we analyze the work you actually do, capture it as traces, cluster it
into the tasks you repeat, turn those tasks into verifiers environments, benchmark
open-weight models against them, and recommend (then route to) the models you can
own — replacing the frontier with self-improving local models.*

```
ClickHouse  ←  Moraine (capture, ingest, MCP)  ←  Understudy (explore, cluster,
benchmark, recommend, route)  ←  Rust desktop app (WebGL viewer) + Understudy MCP
(what your coding agent calls)
```

## Settled decisions (2026-07-19)

- **MVP slice:** WebGL viewer over Moraine — explore/search first; clustering and
  benchmarks layer in behind it.
- **Chosen direction (2026-07-19, after reviewing the four mocks):** `/timeline` —
  the map's point-cloud grammar with time as the x-axis: every session a point
  colored by agent/harness in harness lanes, duration tails, pan/zoom through
  your history, and search that lights up matching sessions while the rest dim.
  Map/river/anatomy/leaderboard remain as reference mocks; anatomy is the
  natural drill-in from a selected timeline session, and the treemap leaderboard
  becomes the Stage 5 recommendation surface.
- **Viz exploration (done):** mocked all four directions on real data:
  1. **Embedding map** — traces/turns as points in projected embedding space;
     clusters = task types.
  2. **Timeline / history river** — sessions, agents, files, cost as a navigable
     temporal landscape.
  3. **Trace anatomy** — one session as a graph/flow of turns, tool calls, files,
     tokens (not a chat log).
  4. **Benchmark/leaderboard overlay** — clusters colored by which open-weight
     model wins them; the recommendation surface itself.
- **Moraine coupling:** keep Moraine's installer/capture/processing as-is; vendor
  its MCP server (Apache-2.0 — retain notices, state changes); Understudy's layer
  may *also* query ClickHouse (`:8123`, db `moraine`) directly for search,
  clustering, and analytics that Moraine's four tools can't express.
- **Local model:** Gemma e2b QAT default rung for trace summarization/labeling +
  a small embedding model for clustering; fine-tune the scanner later once we
  have labeled task data.
- **Dev experience:** iterate in Next.js locally (fast HMR) → embed in the Rust
  desktop app (webview) once a direction wins. No Rust compile loop during design.
- **Prototype home:** `apps/moraine-viewer/` in this repo.
- **Data for mocks:** real local Moraine data, strictly read-only.
- **Styling:** Understudy design language v2.0; shadcn components.

## What Moraine gives us today (v0.7.1)

- Lossless local capture across ~10 harnesses (Claude Code, Codex, Cursor,
  OpenCode, Kimi, Pi, Hermes, NAC, …), realtime + backfill, secret redaction,
  unified `moraine.events` schema in managed ClickHouse.
- Four MCP tools: `search_sessions` (BM25 keyword), `open` (summary-first with
  cursor expansion), `list_sessions`, `file_attention`.
- Monitor UI on `:8080` (analytics, session browse, trace detail) — useful
  reference, not our surface.
- **What it does NOT have** (our greenfield): semantic search, embeddings,
  clustering, task identification, benchmarks, model comparison, routing.

## Jobs to be done (the why behind the stages)

Each job builds the trust the next one spends:

1. **Awareness — "what have my agents been doing?"** The daily ambient job and
   the emotional hook. Served by `/timeline` (lanes, colors, density = your
   week). Missing: cost/token aggregates annotated in the field.
2. **Retrieval — "find that moment."** Highest-frequency deliberate job, shared
   with the coding agent via the future Understudy MCP. Served today by
   search → dim → fly-to → trace preview → anatomy. Keyword-only until Stage 2
   fills summaries/labels. **The wedge job: daily utility before any model
   recommendation exists.**
3. **Self-knowledge — "what is my work made of?"** Task distribution nobody
   knows about themselves. IS Stage 2 (scanner + embeddings + clusters); shows
   up as a color-by-task-cluster mode on the timeline.
4. **Economics — "what's it costing, what could do it cheaper?"** The reason
   Understudy exists. Treemap leaderboard is the surface; becomes real via
   personal benchmarks (Stages 4–5). Only credible per task → depends on job 3.
5. **Action — "make the switch, safely."** Routing + ramp-and-verify in the
   desktop app/gateway (Stage 6). The viewer holds the receipt: "this cluster
   runs on Gemma now, here's the quality delta."

Sequencing consequence: Stage 2 is the single highest-leverage next step — it
upgrades retrieval from cwd-matching to real search AND unlocks the task
catalog everything downstream stands on.

## Stages

### Stage 0 — Foundation ✅ (2026-07-19)
- [x] Update Moraine 0.7.0 → 0.7.1; keep upstream tracking healthy.
- [x] Schema reference (`docs/moraine-clickhouse-schema.md`).
- [x] This roadmap.

### Progress log (2026-07-19/20)
- Stage 1 ✅ — timeline chosen + built: 4 color modes (harness/task/language/cost),
  search-with-dim, click-to-zoom, commit heat strip, live pulse, ingest health,
  full lossless transcript at /session/[id] with subagent nesting + live tail.
  Single control plane; Moraine headless.
- Stage 2 ✅ (sample→full) — all 6,009 sessions scanned with local Gemma e2b QAT;
  91% identified as CodexBar /usage probe plumbing (quarantined); 519 real
  interactive sessions in 11 clusters; MiniLM embeddings + centroid assignment;
  commit-aware digests; task catalog at /tasks with per-cluster exemplars.
- Stage 3 (Understudy MCP) — not started; viewer APIs are the de-facto layer.
- Stage 4 — in progress: benchmark draft builder (cluster → task instances with
  contamination-safe hash splits, benchmark.v1-draft shape, review UI).

### Stage 1 — WebGL viewer MVP (Next.js prototype)
- `apps/moraine-viewer`: Next.js + shadcn + Understudy design-language styling; WebGL via
  react-three-fiber (or regl/deck.gl where instanced 2D wins).
- Thin read-only API routes → local ClickHouse.
- Four mock directions on real data, one route each; pick a winner with Luis.
- Basic search/browse parity with Moraine's tools so exploration is real.

### Stage 2 — Understanding layer (embeddings + local model)
- Embedding pipeline over sessions/turns (small local embedding model);
  store vectors locally (Understudy-owned store — do not write into Moraine's DB).
- Gemma QAT scanner: per-trace summaries, labels, task-type hypotheses.
- Clustering → **task catalog**: the recurring tasks *you* do, with examples,
  frequency, cost, models used. "Document a local history for you."

### Stage 3 — Understudy MCP (the abstraction layer)
- Vendor Moraine's MCP server; wrap/extend as the **Understudy MCP**: coding
  agents call Understudy the way they call Moraine today, plus semantic search,
  task catalog, and (later) benchmark/recommendation queries.
- One layer of abstraction above Moraine; Moraine's tools remain the capture
  substrate.

### Stage 4 — Personalized benchmarks
- Task clusters → verifiers environments (benchmark.v1 spine, verifiers-v1 as
  compile target) built from your real traces: personal benchmarks.
- Contamination-safe splits (curate-trajectories discipline).

### Stage 5 — Model comparison & recommendation
- Run open-weight candidates (local MLX + gateway) against personal benchmarks;
  leaderboard per task cluster; the WebGL overlay becomes the recommendation UI.
- "Best model for your use cases" with receipts.

### Stage 6 — Desktop integration & routing
- Embed the winning viewer in the Rust desktop app (webview over the same local
  API); datasets feature in the app.
- Route recommendations → actual routing (gateway dial / route_policy.rs),
  ramp-and-verify discipline. The fullness of time: self-improving owned models.

## Open questions
- Vector store choice for Stage 2 (sqlite-vec vs LanceDB vs ClickHouse-side —
  but never writing to Moraine's schema).
- How the Understudy MCP composes with the existing understudy gateway/MCP story.
- Schema-drift strategy: pin queries to Moraine versions we've tested; vendored
  MCP tracks upstream tags.
