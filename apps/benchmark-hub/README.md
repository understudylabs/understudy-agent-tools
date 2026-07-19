# Understudy Benchmark Hub

A local, single-user "Environments Hub + leaderboard" viewer over
`understudy.benchmark.v1` manifests and `understudy.eval_result.v1` rows.

## Run

```sh
cd apps/benchmark-hub
bun install        # or npm install
bun run dev        # http://localhost:1421
bun run build      # production check
```

## Screens

- **Hub index (`/`)** — card grid of discovered benchmarks with origin badges
  and first-class evidence warnings (contamination unknown/contaminated, no
  linked production eval, unverified import license, no split discipline).
- **Benchmark detail (`/b/<slug>`)** — leaderboard (sortable, holdout-default
  split filter, exclude-flagged toggle), taxonomy with per-category difficulty
  and score summary, task table, provenance/environment/verifier panels,
  flagging.
- **Task inspector (`/b/<slug>/task/<task_id>`)** — manifest entry, eval rows
  across runs/models, and trace-branch drill-down (root-to-leaf message paths
  from `traces*.jsonl`; graceful empty state otherwise).

## Data-dir contract

The server-side loader (`lib/data.ts`) scans:

1. `BENCHMARK_HUB_DATA_DIR` (env var), if set
2. `<repo>/.understudy/benchmarks`
3. `<repo>/experiments/benchmark-hub-demo` (seeded demo data, writable)
4. `<repo>/tests/fixtures/benchmark-*.json` — mapped as read-only fixture
   entries (flag writes rejected)

Each benchmark is a directory containing:

- `benchmark.json` — required, an `understudy.benchmark.v1` manifest
- `rows-*.jsonl` and/or `rows/*.jsonl` — optional `understudy.eval_result.v1`
  rows (one JSON object per line)
- `traces*.jsonl` — optional message-DAG evidence for the task inspector
- `flags.jsonl` — optional/created `understudy.benchmark_flag.v1` lines

## Flagging

Flags POST to `/api/flags` and append one `understudy.benchmark_flag.v1` JSON
line to `flags.jsonl` next to the manifest (`task_id: null` = whole benchmark).
Fixture-backed entries are read-only and reject writes with a clear message.
Open flags badge the task/benchmark everywhere; the leaderboard's
"exclude flagged" toggle removes open-flagged tasks from aggregates.

Branch/projection logic is vendored from `src/benchmark.ts` at the repo root
(`lib/benchmark-core.ts`); that file is the source of truth.
