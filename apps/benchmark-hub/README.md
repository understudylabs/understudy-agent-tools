# Understudy Benchmark Hub

A local, single-user "Environments Hub + leaderboard" viewer over the whole
benchmark lifecycle: **proposed** trace-foundry outputs awaiting human review
and **promoted** `understudy.benchmark.v1` manifests with
`understudy.eval_result.v1` rows.

## Lifecycle model

A benchmark directory is one of two stages, dispatched by the loader:

- **proposed** — a `understudy traces build-benchmark` (trace foundry) output
  dir: `manifest.json` (`understudy.trace_foundry.v1`) + `tasks.jsonl`
  (`understudy.benchmark_task.v1`) + `source-dag.json` + lazy capture bodies
  under `viewer/data/captures/`. Machine-compiled, non-executable, every task
  pending human final judgment. The dir's `benchmark.json` is a known schema
  name collision (being renamed upstream) and is only cross-checked for task
  ids, never consumed.
- **promoted** — a directory with a valid `understudy.benchmark.v1`
  `benchmark.json` plus rows/traces/flags/versions sidecars.

The hub's entity and task pages serve both stages from one component tree:
proposed benchmarks get a review-first layout (task inbox, source-DAG
lineage, provenance + privacy), promoted benchmarks keep the
leaderboard-first layout. **This replaces the foundry's self-contained
`viewer/index.html` "benchmark orchard" review viewer** — the orchard's
information design (task inbox → lineage rail → parsed/raw capture
inspector → review actions) now lives here in the hub's component and token
system, with decisions persisted to disk instead of localStorage.

## Theme

The app adopts the **trace-viewer theme contract**
(`skills/ingest-traces/templates/trace-viewer/index.html`, docs in
`skills/ingest-traces/references/trace-viewer.md`): the public token tier
(`--background/--foreground/--card/--popover/--primary/--secondary/--muted/
--accent/--destructive/--border/--input/--ring`, `--viz-series-1..6`, the
system `--font-sans`/`--font-mono` stacks, the `--font-size-base` type scale,
and the `--radius`/`--shadow-sm` scale) is copied verbatim into
`app/globals.css`, so the hub and the embedded trace viewer are literally
interchangeable surfaces. Both themes come from `light-dark()`; the default
is **system** (`color-scheme: light dark`) with a header toggle
(system → light → dark) that persists a `theme` cookie and renders as
`<html data-theme="light|dark">` — curl-testable with
`-H 'Cookie: theme=light'`. Interactive/selected states use contract
**primary blue** (the former stamp-clay accent is retired); the old internal
names (`--ground/--surface/--ink/--faint/--series-*`) survive only as a thin
alias layer onto contract tokens during transition.

**Proposed contract extension — state colors.** The contract has no ok/warn
tokens, so the hub defines `--ok: light-dark(rgb(22 128 61), rgb(63 185 80))`
and `--warn: light-dark(rgb(154 103 0), rgb(210 153 34))` (AA ≥ 4.5:1 text
contrast against both `--background` values; validated with the dataviz
palette validator) and maps `--bad` to the contract's `--destructive`. If the
contract grows state colors these should be replaced.

**Known divergence (deliberate):** this drops the Understudy design language
v2.0 black-field/IBM Plex look in favor of the trace-viewer contract, pending
reconciliation in the design repo. IBM Plex `next/font` wiring is removed;
system font stacks are the contract's.

The benchmark detail page remains an OpenRouter-style entity page (header +
stat strip + sticky anchor rail). All design tokens are centralized in the
CSS custom properties (`:root` + Tailwind `@theme`) at the top of
`app/globals.css`; the component classes consume only those variables and
share a single `u-` prefix. Every screen has a designed empty state: one
sentence of what it is plus one concrete next action in mono (`u-empty`).

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
- **Proposed benchmark detail (`/b/<slug>`, stage proposed)** — review-first:
  stat strip (tasks, awaiting review, accepted/rejected, captures+freshness),
  Tasks · Lineage · Provenance anchor rail, task inbox (title, split,
  machine confidence, close-call, review decision), source-DAG lineage rail
  (rounds by `captured_at`, typed edges with confidence and common-prefix
  evidence), and provenance (freshness window, filtered counts, per-capture
  sha256 pointers, privacy card).
- **Task inspector (`/b/<slug>/task/<task_id>`)** — one component tree for
  both stages. Promoted tasks: sidecar `tasks*.jsonl` content (question, gold
  contract, fixtures) as first-class panels, eval rows with subscore chips,
  and trace-branch drill-down (first 20 branches + count). Proposed tasks:
  outcome-contract panels (required/preserved/forbidden with per-item tool,
  observed arguments, matching and confidence chips), world model, machine
  claims (observed/inferred), a task-scoped lineage strip, the review action
  bar, and a lazy capture viewer (parsed chat-style request, SSE-reassembled
  response with tool calls + stop_reason, raw request/response toggle)
  fetched per round via `GET /api/captures?slug&id` — capture bodies never
  ship in the RSC payload. Foundry splits (`construction`/`fit`/`heldout`)
  render with visual parity to `train`/`dev`/`holdout`.

## Data-dir contract

The server-side loader (`lib/data-core.ts`) scans:

1. `BENCHMARK_HUB_DATA_DIR` — a colon-separated list of directories whose
   subdirectories are benchmarks; when unset, `~/.understudy/benchmarks`
2. Only when `BENCHMARK_HUB_DEMO=1` (the `dev` and `start:demo` scripts set
   it): `<repo>/experiments/benchmark-hub-demo` (seeded demo data, writable
   so the flag flow is demoable) and `<repo>/tests/fixtures/benchmark-*.json`
   as read-only fixture entries (flag writes rejected)

Each **promoted** benchmark is a directory containing:

- `benchmark.json` — required, an `understudy.benchmark.v1` manifest
- `rows-*.jsonl` and/or `rows/*.jsonl` — optional `understudy.eval_result.v1`
  rows (one JSON object per line)
- `traces*.jsonl` — optional message-DAG evidence for the task inspector
- `flags.jsonl` — optional/created `understudy.benchmark_flag.v1` lines
- `versions.jsonl` — optional split-freeze history, one
  `{created_at, splits_sha256, contamination, note}` per line, newest last.
  **Viewer-side convention for now — candidate for `benchmark.v1.1`** (the
  schema itself still has a single `splits.splits_sha256`).

A **proposed** benchmark directory (foundry output) instead contains
`manifest.json`, `tasks.jsonl`, `source-dag.json`, `normalized-captures.jsonl`,
`viewer/data/captures/*.json` (lazy bodies), and a hub-written `reviews.jsonl`.

Rows may carry `cost` (USD per rollout) and `latency_ms` extension fields —
`eval_result.v1` allows extra keys. Cost semantics are producer-defined; see
`NOTES.md` in each demo dir for how its numbers were derived.

## Review store (proposed stage)

Review decisions POST to `/api/reviews` and append one
`understudy.benchmark_review.v1` JSON line (`{schema_version, benchmark_id,
task_id, decision, note, created_at}`, decision ∈ accept | restrict |
needs_more | reject, `benchmark_id` = the foundry output dir slug) to an
append-only `reviews.jsonl` next to the foundry manifest. **Newest line per
task wins** (superseding by append). The same guards as flags apply:
read-only entries rejected, decision/task validation, 2000-char note cap, no
directory rescan on write. Reviewed state renders in the inbox, on the task
page, and as index-card progress.

## Flagging (promoted stage)

Flags POST to `/api/flags` and append one `understudy.benchmark_flag.v1` JSON
line to `flags.jsonl` next to the manifest (`task_id: null` = whole benchmark).
Fixture-backed entries are read-only and reject writes with a clear message.
Open flags badge the task/benchmark everywhere; the leaderboard's
"exclude flagged" toggle removes open-flagged tasks from aggregates.

Branch/projection logic is vendored from `src/benchmark.ts` at the repo root
(`lib/benchmark-core.ts`); that file is the source of truth.
