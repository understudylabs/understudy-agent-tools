# Understudy Benchmark Hub

A local, single-user "Environments Hub + leaderboard" viewer over
`understudy.benchmark.v1` manifests and `understudy.eval_result.v1` rows.

## Theme

The app wears the **Understudy design language v2.0 DARK FIELD** (wave 2′):
black-field/card/stamp-dark tokens and IBM Plex Sans/Mono type from
`understudy-design/tokens/{primitives,semantic}.json`. The benchmark detail
page is an OpenRouter-style entity page (header + stat strip + sticky anchor
rail). All design tokens are centralized in the CSS custom properties
(`:root` + Tailwind `@theme`) at the top of `app/globals.css`; the component
classes consume only those variables. The temporary `?accent` preview switch
(middleware → header → `data-accent` bridge) has been **removed**: stamp is
the canonical v2.0 accent, stamped statically by the root layout. The
`html[data-accent]` CSS blocks remain in `globals.css` for the styling pass
to consolidate.

## Run

```sh
cd apps/benchmark-hub
bun install        # or npm install
bun run dev        # http://localhost:1421 (sets BENCHMARK_HUB_DEMO=1: repo demo data + fixtures)
bun run build      # production check
bun run start      # production server, real data dirs only
bun run start:demo # production server incl. repo demo data
```

## Screens

- **Hub index (`/`)** — hero + release timeline (union of all split freezes),
  then a card grid of discovered benchmarks with origin badges
  and first-class evidence warnings (contamination unknown/contaminated, no
  linked production eval, unverified import license, no split discipline).
- **Benchmark detail (`/b/<slug>`)** — numbered sections (01 Leaderboard,
  02 Insights, 03 Evidence, 04 Taxonomy, 05 Tasks, 06 Open flags):
  - **Leaderboard** — sortable, holdout-default split filter; model search,
    local-only / show-route / exclude-flagged toggle chips; per-arm
    **cost p/ successful task** (Σ cost ÷ scored rows ÷ mean strict
    score, div-by-zero guarded) and **p50 latency** columns; category chips
    that re-scope the view to one category; click a row for an inline
    per-category strict/dense/row-count breakdown; route badges
    (local | gateway | byo) from rows' `route`; top-3-per-column shading;
    `//`-style footnotes stating the formulas in force.
  - **Insights** — strict score vs cost-per-successful-task scatter (log x)
    with a step "value frontier" line; zero-cost local arms render in a pinned
    "≈$0 (local)" gutter band instead of being dropped; toggle x to p50
    latency; "COST VIEW" chips re-scope the y score to one category. A
    "Cost, ranked" card shows per-arm cost bars (cheapest first, add-a-model
    select). A "Category profile" radar compares 2–3 selected arms across
    categories (only when ≥3 categories have scored rows).
  - **Evidence** — horizontal split-freeze timeline from `versions.jsonl`
    (short `splits_sha256` hash + contamination verdict per dot; current
    version ringed).
- **Task inspector (`/b/<slug>/task/<task_id>`)** — manifest entry, eval rows
  across runs/models, and trace-branch drill-down (root-to-leaf message paths
  from `traces*.jsonl`; graceful empty state otherwise).

## Data-dir contract

The server-side loader (`lib/data-core.ts`) scans:

1. `BENCHMARK_HUB_DATA_DIR` — a colon-separated list of directories whose
   subdirectories are benchmarks; when unset, `~/.understudy/benchmarks`
2. Only when `BENCHMARK_HUB_DEMO=1` (the `dev` and `start:demo` scripts set
   it): `<repo>/experiments/benchmark-hub-demo` (seeded demo data, writable
   so the flag flow is demoable) and `<repo>/tests/fixtures/benchmark-*.json`
   as read-only fixture entries (flag writes rejected)

Each benchmark is a directory containing:

- `benchmark.json` — required, an `understudy.benchmark.v1` manifest
- `rows-*.jsonl` and/or `rows/*.jsonl` — optional `understudy.eval_result.v1`
  rows (one JSON object per line)
- `traces*.jsonl` — optional message-DAG evidence for the task inspector
- `flags.jsonl` — optional/created `understudy.benchmark_flag.v1` lines
- `versions.jsonl` — optional split-freeze history, one
  `{created_at, splits_sha256, contamination, note}` per line, newest last.
  **Viewer-side convention for now — candidate for `benchmark.v1.1`** (the
  schema itself still has a single `splits.splits_sha256`).

Rows may carry `cost` (USD per rollout) and `latency_ms` extension fields —
`eval_result.v1` allows extra keys. Cost semantics are producer-defined; see
`NOTES.md` in each demo dir for how its numbers were derived.

## Flagging

Flags POST to `/api/flags` and append one `understudy.benchmark_flag.v1` JSON
line to `flags.jsonl` next to the manifest (`task_id: null` = whole benchmark).
Fixture-backed entries are read-only and reject writes with a clear message.
Open flags badge the task/benchmark everywhere; the leaderboard's
"exclude flagged" toggle removes open-flagged tasks from aggregates.

Branch/projection logic is vendored from `src/benchmark.ts` at the repo root
(`lib/benchmark-core.ts`); that file is the source of truth.
