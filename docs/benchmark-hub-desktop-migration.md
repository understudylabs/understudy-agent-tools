# Shipping the Benchmark Hub — `apps/benchmark-hub` → understudy-desktop

**Status:** scoping v1 — 2026-07-22 (DOC ONLY; no migration code on this branch)
**Prototype:** `apps/benchmark-hub` (Next 15, standalone dev server on :1421).
**Target:** `apps/homescreen` (Tauri + Next 15 static export).
**Companion plan:** [`docs/desktop-integration-plan.md`](desktop-integration-plan.md)
(the Moraine Explore migration, 2026-07-20) — same constraints, same patterns;
this doc reuses its vocabulary and does not restate what it already settled.

## Product shape

The hub is the local "Environments Hub + leaderboard" over the benchmark
lifecycle: proposed trace-foundry outputs awaiting human review, and promoted
`understudy.benchmark.v1` dirs with `understudy.eval_result.v1` rows. In the
desktop app it becomes a third top-level section next to Chat and Explore Data
(**Chat | Explore Data | Benchmarks**), flattening the hub's Next routes into
pane view-state exactly as Explore does.

## The same one hard constraint

`apps/homescreen` is `output: "export"` — static files in a WKWebView, **no
Node runtime**. The hub's nine route handlers (`apps/benchmark-hub/app/api/`)
are all `node:fs` reads/appends over benchmark directories plus one outbound
gateway fetch. None can ship as-is; all data access moves to Rust `invoke`
commands (a new `src-tauri/src/benchmarks.rs`), same as `explore.rs`.

Two facts make this migration *easier* than Explore:

1. **No database.** Everything is file-based JSONL/JSON under a benchmark dir.
   No ClickHouse proxy, no sqlite. `serde_json` + `std::fs` covers it.
2. **The hub never executes.** POST `/api/runs` only writes an
   `understudy.run_request.v1` file into `<benchmark>/runs/queue/`;
   `understudy runs execute --benchmark <dir> --watch` (the CLI executor,
   `src/commands/runs.ts` → `src/run-executor.ts`) is the only thing that runs
   models. The desktop app keeps that separation — it just becomes the
   process manager for the executor instead of a README hint.

And one fact makes it *harder*: the hub's server-side logic is not "query
building + JSON shaping" like Explore's 13 routes. `lib/replay-core.ts`
(deterministic contract accumulation), `lib/benchmark-core.ts` (trace branch
extraction), and `lib/data-core.ts` (two-stage entry loader with slug-prefix
hardening) are real shared logic that the CLI also uses. **Do not port them to
Rust.** See "shared compiled core" below.

## The shared compiled core (decide this first)

Today the hub's routes import from `lib/*-core.ts`, which re-export or mirror
the CLI's compiled foundry/executor logic (`replay-core` re-exports the
compiled foundry's accumulation; `gateway-core` imports the CLI's credential
resolver *from dist* — "never forked"). Three options for the desktop:

- **(a) Rust rewrite** of data-core/replay-core/benchmark-core — rejected:
  the accumulation scorer must stay byte-identical between hub, CLI executor,
  and offline validation. Two implementations of the scorer is the
  legacy-journal bug class all over again (see PR #323's revert).
- **(b) Rust invoke commands that shell out to the bundled CLI**
  (`build-desktop-cli.mjs` already ships the CLI inside the app, per the
  Explore plan). Reads become `understudy benchmarks <verb> --json`
  subcommands the CLI grows; Rust is a thin spawn+parse wrapper.
- **(c) Sidecar Node process** holding the hub's lib/ warm — rejected: a
  long-lived hidden Node server is exactly what "no Node runtime" is for.

**Recommendation: (b)**, with a small carve-out: trivially-file-shaped
commands (append a flag line, list queue files, tail a journal) go native in
`benchmarks.rs` for latency, but anything that touches the **scorer or the
entry loader** goes through the CLI so there is exactly one compiled
implementation. This means the migration's first PR is CLI-side: a
`understudy benchmarks` command group exposing today's route logic as JSON
verbs (`list`, `entry <slug>`, `replay <slug> <task>`, `rollouts`, `captures`,
`trace-viewer`, `flag`, `review`, `queue-run`, `cancel-run`). The hub's route
handlers become thin callers of the same functions — proving the extraction
before the desktop consumes it.

## Route-by-route migration table

Legend: **CLI-backed** = Rust spawns the bundled CLI verb and relays JSON.
**Native** = pure `std::fs`/`serde_json` in `benchmarks.rs`. All paths are
relative to the benchmark dir under the data home (next section).

| Hub route (today) | Desktop surface | Reads / writes | Core it must reuse |
|---|---|---|---|
| `GET /api/runs?slug` | `benchmarks_runs_list(slug)` — **native** | reads `runs/queue/*.json` (`run_request.v1`) | `runs-core.ts` listing logic is trivial file enumeration; safe to go native |
| `POST /api/runs` (queue) | `benchmarks_run_queue(slug, models, split, tasks, rollouts_per_task)` — **CLI-backed** (`understudy benchmarks queue-run`) | reads `benchmark.json`, `tasks.jsonl`, `environment/offline-validation.json`, `reviews.jsonl`; writes `runs/queue/<run_id>.json` | `runs-core.ts` validation + `selectTasks` + proposed-task gating (accepted + oracle-validated only). Too much invariant logic to fork |
| `POST /api/runs` (cancel) | `benchmarks_run_cancel(slug, run_id)` — **native** | rewrites the request file's `status` | status-flip only; executor honors it between rollouts |
| `GET /api/runs/live` | **deleted — replaced by Tauri events** (next section) | (today: polls `runs/live/<run>-<model>.jsonl` + re-scores) | `replay-core` accumulation moves into the executor's event emission |
| `POST /api/flags` | `benchmarks_flag_append(slug, task_id, reason, note)` — **native** | appends one `benchmark_flag.v1` line to `flags.jsonl` | validation constants (`FLAG_REASONS`, note cap) duplicated as Rust consts — acceptable, they're data not logic |
| `POST /api/reviews` | `benchmarks_review_append(slug, task_id, decision, note)` — **native** | appends one `benchmark_review.v1` line to `reviews.jsonl` | same as flags |
| `GET /api/models` | **already exists** — reuse the app's model-listing path (`models.rs` / gateway client with `creds.rs`) rather than porting `gateway-core.ts` | outbound gateway `/v1/models`, 5-min cache | none; delete the hub's copy. The sk_ key stays in Rust, never in the webview (same property the route had) |
| `GET /api/replay?slug&task` | `benchmarks_replay(slug, task)` — **CLI-backed** (`understudy benchmarks replay`) | reads capture bodies (`viewer/data/captures/*.json`), `tasks.jsonl` sidecars, eval rows, `environment/offline-validation.json` | `replay-core.ts` — THE scorer. Never forked |
| `GET /api/rollouts?slug&task` | `benchmarks_rollouts(slug, task)` — **CLI-backed** | reads `traces*.jsonl`, eval rows; joins via `trace_ref.branch_leaf` | `benchmark-core.ts` branch extraction + `trajectory-core.ts` |
| `GET /api/captures?slug&id\|task` | `benchmarks_capture(slug, id)` / `benchmarks_capture_meta(slug, task)` — **CLI-backed** (meta derivation) or native (raw body read) | reads `viewer/data/captures/*.json` via the entry's capture index | `data-core.ts` `captureFilePath` (no client-supplied path ever touches fs — keep that property in Rust argument validation too) |
| `GET /api/trace-viewer` | `benchmarks_trace_viewer(slug, task, trace?)` — **CLI-backed**; serve the built artifact via Tauri asset protocol or convertFileSrc, keeping the `index.html`/`trace-data.js` allowlist | writes/reads `.trace-viewer-cache/` in the benchmark dir | `trace-viewer-core.ts` → CLI's `renderTraceViewer` (already CLI code) |

Frontend: a thin `app/lib/benchmarksData.ts` adapter in homescreen with the
same function signatures the hub components already call, implemented via
`invoke()` — identical to the Explore plan's `exploreData.ts` move.

## Live-rollout streaming: push, not poll

Today's `/api/runs/live` is the worst surface in the hub and should not be
ported: the executor appends a JSONL journal
(`runs/live/<runId>-<model>.jsonl`, advertised on the request file's `live`
field), and the hub polls it with a `since` line offset, tolerating torn tail
lines and re-reading the *whole* journal every poll to recompute accumulation.
Two processes sharing an append-only file format is exactly the class that
produced the legacy-journal newline bug (in-string `\n` escapes made the split
unparseable — see the PR #323 revert). The file stays as the **durable
artifact** for post-run replay-scrubbing; it stops being the **transport**.

Redesign: the desktop-managed executor emits events; Rust forwards them as
Tauri events; the webview listens. No polling anywhere.

- The executor already has a structured `RunEvent` callback (`onEvent` in
  `executeQueuedRuns`, currently pretty-printed to stderr). Add
  `understudy runs execute --emit-json` that writes one JSON event per line to
  **stdout** (stderr keeps the human format). Rust owns the child process and
  is the *only* reader of that pipe — a pipe, not a shared file, so no torn
  lines, no offsets, no mtime races.
- `benchmarks.rs` relays each line as a Tauri event, mirroring the
  `oracle_dispatch.rs` emit pattern already in the app.

**Event contract** (`understudy.run_event.v1`; channel
`benchmarks://run-event`):

```json
{
  "schema_version": "understudy.run_event.v1",
  "ts": "2026-07-22T04:12:09.331Z",
  "benchmark_dir": "~/.understudy/benchmarks/<slug>",
  "run_id": "run_9f3k",
  "type": "run_started | arm_started | call | call_result | rollout_scored | arm_finished | run_finished | run_failed | run_cancelled",
  "model": "gemma-4-e2b-understudy",
  "task_id": "task_003",
  "rollout": 1,
  "progress": { "completed": 3, "total": 12 },
  "score": 0.5,
  "subscores": { "final_state": 1, "final_state_partial_credit": 0.5 },
  "call": { "tool": "update_record", "arguments_summary": "…", "status": "ok" },
  "accumulation": { "met": 4, "total": 7, "obligations": [ { "id": "…", "met": true } ] },
  "error": null
}
```

Rules:
- Fields absent when not applicable (`call` only on call/call_result, `score`
  only on rollout_scored, etc.).
- `accumulation` is computed **in the executor** (which already owns
  `replay-core` and the task contract) and shipped ready-to-render, so the UI
  never re-derives scores from raw calls — the scorer runs in one process.
- `arguments_summary` is a capped string, not raw arguments: full payloads stay
  in the journal file on disk; events are UI-sized (cap the line at ~8KB, no
  capture bodies over the event bus).
- Sequence numbers per run (`seq`) so the UI can detect a dropped event and
  fall back to a one-shot `benchmarks_run_state(run_id)` invoke that reads the
  request file + journal — the journal remains the recovery path, never the
  hot path.
- Post-run scrubbing (the Replay tab's timeline) keeps reading the journal
  file via the CLI-backed replay verb; that is a read of a *finished* file, which
  is fine.

## Data home: `~/.understudy/benchmarks/`

Good news: `lib/data-core.ts` already defaults to
`~/.understudy/benchmarks` when `BENCHMARK_HUB_DATA_DIR` is unset, and the
repo-checkout scan root (`path.resolve(process.cwd(), "..", "..")`) plus the
`BENCHMARK_HUB_DEMO=1` fixture root are dev-only. So the *hub's* reads are
already home-relative. The risks are the paths **baked into artifacts at
generation time**:

| Baked-at-generation path | Where | Relocation risk |
|---|---|---|
| `execute_hint: "understudy runs execute --benchmark <ABSOLUTE dir> --watch"` | `POST /api/runs` response and the Replay tab's `environment.cli` string | Cosmetic-but-misleading after a move; in the desktop app the hint disappears entirely (the daemon executes) — delete the field from the desktop surface, keep it CLI-only |
| `live.journal` on the run-request file | written by `run-executor.ts` — **already benchmark-dir-relative** (`relative(dir, journalPath)`) | none; keep this discipline for any new pointer fields |
| `source.captures[].capture_id` → `viewer/data/captures/*.json` | foundry output; resolved via the entry's capture index, relative | none |
| `environment/` (generated verifiers env: `pyproject.toml`, `understudy_trace_env/`, uv venv/lock) | `understudy traces build-benchmark` output | **highest risk**: uv virtualenvs and lockfiles can embed absolute interpreter paths. Moving a benchmark dir after generation may break `uv run … eval` silently. Rule: the environment must be reproducible from its dir (`uv sync` on first run in the new location), and the executor should treat a failed spawn as "environment needs rebuild", not a task failure |
| `.trace-viewer-cache/` | built lazily by the trace-viewer route | cache keyed by content hashes; safe to nuke on move — document "cache dirs are disposable" |
| `offline-validation.json`, `benchmark.json`, `rows*.jsonl`, `flags.jsonl`, `reviews.jsonl` | all read relative to the dir | none |

**artifact-contracts note (honest):** `docs/artifact-contracts.md` does **not**
exist on `main` as of 2026-07-22 (checked `git ls-tree origin/main docs/`).
The unification it was meant to capture — one written contract for
`run_request.v1` / `run_event` / `eval_result.v1` / journal schemas shared by
CLI, hub, and desktop — is a prerequisite of Phase 1 below and should land as
that doc (or fold into this one) before `benchmarks.rs` hardcodes anything.

Migration mechanics: benchmarks generated into repo checkouts move with a
one-shot `understudy benchmarks adopt <dir>` (copy/move into
`~/.understudy/benchmarks/<slug>`, verify entry loads, warn on environment/
staleness). The desktop app only ever scans the home; `BENCHMARK_HUB_DATA_DIR`
remains a dev override for the standalone hub, which stays alive as the
HMR-speed prototype harness (same decision as the Moraine viewer).

## Daemon consolidation

Today there are two "daemons" adjacent to this feature: the desktop app's own
agent daemon (`~/.understudy/agent-card.json`, health-probed base_url on
:17790, surfaced by `understudy daemon status`) and the ad-hoc
`understudy runs execute --watch` loop a user must remember to start. Fold the
executor into desktop management:

- **Who starts it:** the app. `benchmarks.rs` spawns the bundled CLI
  (`understudy runs execute --benchmark <dir> --emit-json`) as a managed child
  — the same managed-job pattern as `residency.rs` model servers and the
  Explore plan's v2 scan job. Preferred mode: **on-demand, per queued run**,
  not an always-on `--watch` poller; the app knows the instant a run is queued
  (it wrote the file) so `--watch`'s 30s polling is dead weight on desktop.
  `--watch` remains the headless/CLI-only mode.
- **Who stops it:** the app, on run completion/cancel/app-quit. Cancellation =
  status flip on the request file (unchanged contract) + SIGTERM if the arm
  must die now. Note the smoke-testing finding that MLX servers survive app
  quits — decide explicitly whether an in-flight run should survive quit
  (probably yes, finish the rollout, since rows append incrementally) and
  reattach via the request file's `live` field on relaunch.
- **Single instance:** the known multi-session :17790 collision class applies
  directly — two app sessions (or app + manual CLI `runs execute`) can both
  pick up the same queue. The queue files need a claim: executor writes
  `claimed_by: {pid, started_at}` on transition to running, and refuses
  requests already claimed by a live pid (pid-check exactly like
  `daemonStatus()` does). That fix belongs in `run-executor.ts` and benefits
  the CLI path too, desktop or not.
- **Privacy boundary:** nothing leaves the machine without an explicit verb.
  The executor's only egress is model inference through the gateway with the
  user's own creds (env / `~/.understudy/credentials.json`) — that is the run
  the user asked for. Everything else is local files. Keep the existing gate
  pattern: uploads are opt-in flags only (`understudy traces … --push`, off by
  default, per `src/commands/traces.ts`), telemetry is opt-in
  (`docs/telemetry.md`), and per `docs/privacy-and-data-boundaries.md` the
  desktop app must not add any implicit publish path for benchmark dirs,
  rows, or journals. A future "share to hub" is a new explicit verb, not a
  default.

## The write-authority question

Endgame: evals that can modify the user's source code (an environment whose
task is "fix this bug in the user's repo", scored on the resulting state). The
hub deliberately has **no write authority** beyond appending review/flag lines
inside benchmark dirs; the daemon/executor is the thing with hands. Where
should agent-driven code-edit authority live?

**Option A — daemon verb** (`understudy runs execute` grows a
workspace-mutation capability: the environment requests edits, the executor
applies them in a sandbox/worktree):
- - The executor is a scoring harness; teaching it to edit code turns the
  most-trusted, least-supervised process into the most dangerous one, behind
  no interactive approval surface. Its permission model today is "can append
  to a benchmark dir" — the jump to "can edit any repo" is enormous.
- - Duplicates what coding agents already do well (tool loops, diffs,
  reverts, permission prompts).
- + One process, no protocol hop; deterministic replay of edits from the
  journal.

**Option B — coding-agent-via-MCP** (the executor exposes the *task* over an
agent surface; a coding agent with its own permission system performs edits;
the executor only *scores* the resulting state):
- + Authority lives where consent UX already exists (the agent harness asks
  the user; the executor never holds edit rights).
- + Matches the repo's architecture: `:17790` is "an agent surface"
  (Explore plan), `oracle_dispatch.rs` already brokers agent work, and the
  agent-operator MCP surface on branch `anthro/agent-operator-surface` is
  being built as exactly this kind of broker. **Honesty note:** as of this
  writing no PR exists for that branch (checked `gh pr list --state all`),
  so treat its shape as directional, not a dependency.
- - Two processes to coordinate; scoring must be robust to the agent doing
  arbitrary things to the workspace (which final-state scoring already is,
  by design).

**Recommendation: B.** The executor keeps zero write authority outside
benchmark dirs; code-edit tasks run as: daemon prepares an isolated workspace
(git worktree or copy — never the user's live checkout by default), hands the
task to a coding agent via the MCP/agent-operator surface, then scores final
state and journals the diff. The single new daemon capability is
"materialize and reap a sandbox workspace", which is far smaller than "edit code".
Escalation to the user's real tree is a separate explicit verb with its own
consent prompt, consistent with the privacy boundary above.

## Phases

### Phase 0 — artifact contract + CLI verbs (must land first) [~1-2 sessions]
1. Write `docs/artifact-contracts.md` (doesn't exist yet): `run_request.v1`,
   `run_event.v1` (new), journal line schema, `eval_result.v1`, dir layout,
   the relative-paths-only rule.
2. `understudy benchmarks` CLI command group wrapping today's `lib/*-core.ts`
   logic as JSON verbs; hub routes become thin callers (proves extraction;
   hub behavior unchanged). Add `--emit-json` to `runs execute`.
3. Queue claim field (`claimed_by` + pid check) in `run-executor.ts` —
   ships value even with no desktop work.

### Phase 1 — Benchmarks pane MVP (read + review) [~2 sessions]
4. `src-tauri/src/benchmarks.rs`: native list/flags/reviews/cancel commands +
   CLI-backed entry/replay/rollouts/captures; `benchmarksData.ts` adapter.
5. Port list → entity → task pages into pane view-state (no Next routing);
   models picker rides the existing Rust gateway client.
6. Gate: static export green; review/flag round-trips verified on a real
   `~/.understudy/benchmarks` dir.

### Phase 2 — managed runs + live events [~2 sessions]
7. Managed executor spawn per queued run; `benchmarks://run-event` relay;
   live watch UI moves from polling to `listen()`; reattach-on-relaunch.
8. `understudy benchmarks adopt` + environment-relocation handling
   (`uv sync`-on-first-run, cache-dir disposability).

### Phase 3 — release + write-authority spike [~1 session + spike]
9. Version-lockstep bump, PR, gates, updater train (same as Explore Phase C).
10. Separate spike (not release-gated): sandbox-workspace daemon verb +
    agent-operator MCP handoff prototype, pending that branch's PR.

Rough total: **6-8 sessions**, of which Phase 0 is prerequisite and Phases
1/2 can ship as separate updater releases.

## Risks / open questions

- **CLI-backed invoke latency**: each read spawns bun/node. Explore avoided
  this with rusqlite; we're accepting spawn cost to keep one scorer. If
  entry/replay reads feel slow, the fallback is a `--serve-stdio` batch mode
  on the CLI (one long-lived child per pane session), not a Rust port.
- **Scorer drift** is the existential risk of any shortcut here; the rule
  "accumulation is computed only in CLI-compiled code" must survive review
  pressure to "just port this one function".
- `docs/artifact-contracts.md` does not exist yet; Phase 0 item 1 is real
  work, not a checkbox.
- The agent-operator surface has no PR yet; the write-authority
  recommendation stands on its own but the concrete handoff API is TBD.
- Run-in-flight-across-app-quit semantics need a product decision (finish vs
  kill); this doc assumes finish + reattach.
- Trace-viewer artifact serving from a benchmark dir inside WKWebView (asset
  protocol scoping to `~/.understudy/benchmarks`) is unverified; may need the
  same convertFileSrc capability plumbing as other file-backed panes.
- Proposed-vs-promoted gating logic (accepted-single-task pre-promotion runs)
  is subtle and currently enforced in the route; it must move into the CLI
  verb so the desktop cannot drift from the standalone hub.
