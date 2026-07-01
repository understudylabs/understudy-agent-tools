# Wave 5b — Real eval gallery: wire the drilldown UI to live benchmark data

**Dependencies:** wave 3 (`understudy.eval_result.v1`) merged. If wave 5a
(`anthro/wave5a-daemon-parity`) is unmerged, coordinate: it adds a run
registry + cancellation to the benchmark loop but does NOT touch the frontend
eval panes (those are yours).

**Warning:** `apps/homescreen/app/components/TrainingPane.tsx` may carry
uncommitted user changes in the primary working tree — always work in a fresh
worktree from origin/main, and expect the user to reconcile their local edits
after your PR lands. Flag this in the PR body.

**Goal:** the app's eval surface shows real benchmark data, live. Today the
mounted `EvalExplorerPane` renders fully mocked data while the actually-wired
`FusionEvaluationPane` is unmounted dead code (both in
`apps/homescreen/app/components/TrainingPane.tsx`; find current line numbers
with grep — the file moves fast).

## Work

1. **Wire the explorer/drilldown UI to real data.** Replace
   `EvalExplorerPane`'s mocked rows with the real `fusion_benchmark_*` tauri
   commands (list/summary/results — see `apps/homescreen/src-tauri/src/commands.rs`
   registrations in `lib.rs`) and `eval_result.v1` rows from the export path.
   Live runs stream via the `FusionEvalEvent` channel (RunStarted /
   CandidateStarted / RowStarted / RowFinished / RunFinished) — #117 made the
   event `run_id` consistent (parent id + candidate field); correlate on that.
2. **Remove or fold in the dead pane.** `FusionEvaluationPane` is unmounted;
   keep whichever pieces the explorer needs and delete the rest — no dead
   code left behind.
3. **Score rendering:** wave 3 fixed score-0-renders-as-queued via null
   checks; verify it holds in whatever rendering you build (a 0.0 score is a
   real result, "unscored"/null is not — treat `status: "unscored"` rows
   distinctly).
4. **Do NOT build the Capture pane backend** — explicitly deferred by the
   user. Do not add gateway capture calls to the app in this PR.
5. **Prove it end-to-end:** run a small benchmark suite (via the UI, or the
   wave-5a HTTP endpoint if merged), watch rows stream into the gallery,
   drill into a row, export. Screenshot or transcript in the PR body.
   The repo runs with `pnpm tauri dev` in `apps/homescreen` (or check
   `.claude/launch.json` / package.json scripts).

## Verification

- `npm ci && npm test` at root; `cargo check --all-targets` + `cargo test`
  if any Rust changed; frontend typecheck (`npm run check` covers it).
- Manual: the end-to-end run above. If a headless environment prevents
  running the GUI, say so explicitly in the PR and get a human smoke test
  before merge.

## Landing

Branch `anthro/wave5b-eval-gallery`, PR titled "Wire the eval gallery to real
benchmark data". Follow docs/dev-run/landing-checklist.md.
