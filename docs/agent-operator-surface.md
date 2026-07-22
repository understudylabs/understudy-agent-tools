# Agent operator surface: `understudy benchmarks mcp`

A stdio MCP server that exposes the file-based benchmark artifacts to a
coding agent, so the agent — not a human clicking through the hub — can
author, diagnose, and fix a benchmark workload end to end (the Raindrop
Workshop pattern: put traces and evals inside the agent's tool surface).

```bash
understudy benchmarks mcp                 # roots: ~/.understudy/benchmarks
understudy benchmarks mcp --root ./bench  # add extra roots (repeatable)
```

Claude Code registration (`~/.claude.json` → `mcpServers`):

```json
{ "understudy-benchmarks": { "type": "stdio", "command": "understudy", "args": ["benchmarks", "mcp"] } }
```

## What it serves

| Tool | Reads/writes | Shared core |
| --- | --- | --- |
| `list_benchmarks` | benchmark dirs under the roots: stage (proposed/promoted), task counts, review summary | `dist/benchmark-hub-core.js` `loadHub` |
| `read_benchmark` | manifest + task list with latest review decisions and score summaries | same loaders as the hub pages |
| `read_task` | prompt/statement, outcome contract, world-model summary, review history | `loadTaskSidecars` / foundry `tasks.jsonl` |
| `read_rollout` | trajectory from `runs/live/<run>-<model>.jsonl` + per-obligation contract scoring | `dist/benchmark-replay.js` `accumulateReplay` (the Replay tab's scorer) |
| `diff_rollouts` | side-by-side obligations + first tool-call divergence between two runs | same |
| `submit_review` | appends `understudy.benchmark_review.v1` to `reviews.jsonl` | `submitReview` — the exact validation behind `POST /api/reviews` |
| `apply_auto_accepts` | appends `source:"auto"` accept lines per the review policy (`review-policy.json`, defaults when absent) — only needed under `default_decision: "pending"`; the default is born-accepted, where machine signals surface as `attention_flags` on `read_benchmark`/`read_task` instead. The tool call **is** the explicit user action | `applyAutoAccepts` — the exact code behind `POST /api/reviews/auto` |
| `submit_feedback` | appends `understudy.task_feedback.v1` to `feedback.jsonl` and returns the regenerate-env agent handoff | `submitTaskFeedback` — the exact code behind `POST /api/feedback` |
| `queue_run` | writes `understudy.run_request.v1` into `runs/queue/` — **never executes** | `queueOrCancelRun` — the exact validation behind `POST /api/runs` |
| `run_status` | request status + row summary as `rows-*.jsonl` land, plus the calibration block (incumbent gate + null/spam trivial-arm floors) | `run-executor` readers |

Execution stays where it always was: `understudy runs execute --benchmark
<dir> --watch` (or the daemon) picks queued requests up. The MCP server is a
pure operator surface over the sidecar files.

## The anti-drift rule this extends

The hub never forks format logic: `apps/benchmark-hub/lib/runs-core.ts`
re-exports the CLI's compiled `dist/run-executor.js`. This surface extends
that pattern in the other direction — the loaders and write validation that
used to live only in the app's `lib/` were lifted into the CLI package:

- `src/benchmark-hub-types.ts` → shimmed by `apps/benchmark-hub/lib/types.ts`
- `src/benchmark-hub-core.ts` (loaders + `submitReview` + `queueOrCancelRun`)
  → shimmed by `apps/benchmark-hub/lib/data-core.ts`; the `/api/reviews` and
  `/api/runs` routes are now thin HTTP maps over these functions
- `src/benchmark-replay.ts` (`accumulateReplay`) → shimmed by
  `apps/benchmark-hub/lib/replay-core.ts`

If a sidecar format changes, change it once in `src/` — the hub and the MCP
server pick it up from the same compiled module.

## The agent loop

The intended improvement cycle, tool by tool:

1. **Find the failure.** `list_benchmarks` → `read_benchmark(slug)` → spot
   tasks with low mean scores or `needs_more`/`reject` reviews.
2. **Read the failing rollout.** `read_task(slug, task_id)` for the contract,
   then `read_rollout(slug, run_id, task_id, model)` — the obligations list
   shows exactly which required entries never flipped to met, and the event
   stream shows what the model actually called.
3. **Diff against the incumbent/oracle.** `diff_rollouts(slug, task_id,
   run_incumbent, run_candidate)` — `tool_sequence.diverges_at` names the
   first step where the trajectories part ways; the obligations table shows
   what the passing run satisfied that the failing one didn't.
4. **Fix the right thing.** Two cases:
   - the *task* is wrong (over-tight contract, bad gold, ambiguous prompt):
     `submit_review(slug, task_id, "needs_more" | "reject", note)` with the
     evidence, or edit the task/environment in the benchmark dir;
   - the *system under test* is wrong: edit prompts/code in the workload.
5. **Re-run.** `queue_run(slug, models, tasks?)` — this only writes the
   request file; make sure `understudy runs execute --benchmark <dir>
   --watch` is running.
6. **Re-check.** Poll `run_status(slug, run_id)` until rows land, then
   `read_rollout`/`diff_rollouts` against the previous run to confirm the
   obligation that used to fail now passes — and nothing else regressed.

Repeat until no task carries an unresolved override (`effective_decision`
accept — an explicit re-accept or the born-accepted default) and the score
summary holds across models you care about.

### Current-code regression loop (app replay)

When the fix in step 4 is an edit to the **user's own application** (prompts,
routing, agent code), the model arms above only tell you what a model would
do — the `app_replay` arm tells you what the *app as it now exists* does on
the same frozen tasks (see [`app-harness.md`](app-harness.md)):

1. Author (or update) `app-harness.json` in the benchmark dir — a coding
   agent drafts it from the user's repo (`understudy.app_harness.v1`).
2. Edit the user's code.
3. Queue an app-replay run: `POST /api/runs` / `queue_run` with
   `app_replay: true` (the request records `requires: ["app_replay"]`, so an
   old executor skips it with `run_unsupported` instead of corrupting it).
4. `understudy runs execute --benchmark <dir> --watch` launches the app per
   task with gateway-redirect env, kills it at the per-task timeout, and
   scores observed tool events through the shared contract scorer.
5. Read the rows: they are labeled `arm_kind: "app_replay"`, never feed
   calibration, and rows whose tool effects were not observable carry the
   honest `app_replay_unobserved` anomaly rather than a fabricated score.
6. Regression verdict = compare the app-replay rows on the frozen task set
   before vs after the code edit.

## Guardrails

- Reviews are append-only; the newest line per `task_id` wins. Decisions:
  `accept`, `restrict`, `needs_more`, `reject`. Tasks with no line are
  **born accepted** (review-policy `default_decision: "accept"`, the default);
  `default_decision: "pending"` restores the explicit-accept flow.
- `queue_run` on a *proposed* benchmark accepts exactly one **effectively
  accepted** task (born accepted, or explicitly re-accepted; an explicit
  reject/restrict/needs_more blocks) with a validated environment (same
  gating as the hub); full runs require promotion
  (`understudy traces promote`).
- Read-only sources (demo/fixture) reject writes.
- Journals and row files are read with line caps; malformed lines are skipped,
  never fatal.
