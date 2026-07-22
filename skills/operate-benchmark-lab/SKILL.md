---
name: operate-benchmark-lab
description: Use when a coding agent must operate the full benchmark lifecycle over local benchmark dirs — "build a benchmark from my traces and run models on it", "review and calibrate the eval", "queue a prompt experiment", "is an executor running", "read the rigor report". Covers traces → build-benchmark → review/feedback → calibration floors → candidate and prompt-override runs → rigor/CI reading → app-replay regression, via the benchmarks MCP server or CLI verbs, plus the run-executor daemon lifecycle.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Operate the benchmark lab

The operator's manual for the whole benchmark/experiment lifecycle a coding
agent can drive end to end. Two interfaces over the same sidecar files:
the **benchmarks MCP server** (preferred for agents — same validation code as
the hub API) and the **CLI verbs**. Execution always happens in a separate
executor process; the MCP server and hub never run models. Command matrix,
artifact map, and daemon details in [`reference.md`](reference.md); the tool
table and agent loop in `docs/agent-operator-surface.md`.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js benchmarks mcp --root <dir>
```

MCP registration (Claude Code `~/.claude.json` → `mcpServers`):
`{ "understudy-benchmarks": { "type": "stdio", "command": "understudy", "args": ["benchmarks", "mcp"] } }`
— default root `~/.understudy/benchmarks`; add `--root` per extra directory.

## Safety Gates

- **Queueing is not executing.** `queue_run` / `understudy runs queue` only
  writes a request file. Model rollouts spend gateway money only when an
  executor picks the request up; say which executor will, before queueing.
- **One executor per benchmark dir.** Before starting `runs execute --watch`,
  check for a live claim (`claimed_by` on the request, `executor_version` on
  events) — a stale watcher built before a feature landed is the classic
  corruption hazard; new requests carry `requires:[...]` so old executors skip
  them with `run_unsupported` instead of running them bare.
- Reviews and feedback are append-only ledgers; never edit
  `reviews.jsonl`/`feedback.jsonl` lines in place. `apply_auto_accepts` is
  itself the explicit user action — invoke it only when the developer asked
  for the review pass.
- Honest reporting only: anomaly rows (`rollout_timeout`,
  `app_replay_unobserved`, structural sentinels) are excluded from aggregates
  but reported, never fabricated as scores. Overlapping CIs are a tie.

## The lifecycle

1. **Build.** Captured traces → `understudy traces build-benchmark`, then
   `understudy traces author-tasks` (gateway) for legible task definitions.
   The generated environment already ships the fixtures pre/post split
   (candidate-readable `fixtures.json` vs scorer-only `gold.json`) and the
   tiered gold-leakage audit (tier 1 verbatim findings, tier 2 fuzzy
   advisory) recorded in `manifest.leakage_audit` — read it, don't re-derive.
2. **Review (exception-based).** `list_benchmarks` → `read_benchmark` →
   `read_task`; run `apply_auto_accepts` so the review policy
   (`review-policy.json`, defaults when absent) accepts the routine tasks,
   leaving only exceptions for human/agent judgment via `submit_review`
   (`accept | restrict | needs_more | reject`, newest line per task wins).
   Task or environment wrong? `submit_feedback` appends the ledger entry and
   returns the regenerate-env handoff (`understudy traces regenerate-env`).
3. **Promote and calibrate.** `understudy traces promote` unlocks full runs.
   Queue the incumbent (`--incumbent` / `incumbent_models`) plus
   `trivial_arms: ["null_agent", "spam_agent"]`. Read `calibration.json`:
   `null_floor`/`spam_floor` with `floor_exceeded: true` (> 5%) names the
   `passed_task_ids` to fix; incumbent-failed tasks are flagged suspect —
   fix the benchmark before trusting any candidate score.
4. **Run candidates and prompt experiments.** `queue_run` with candidate
   models; prompt experiments ride `prompt_overrides`
   (`--prompt-override <arm_label>=<model>=<suffix-file>`, e.g. an SOP
   suffix appended to each task's system prompt) so prompt and model arms
   land in the same run under distinct arm labels.
5. **Execute.** Make sure exactly one executor is running:
   `understudy runs execute --benchmark <dir> --watch` (daemon; polls every
   30s) or omit `--watch` for a single pass. Poll `run_status` until rows
   land; `rollout_timeout` kills hung rollouts into anomaly rows.
6. **Read results rigorously.** `read_rollout` / `diff_rollouts`
   (`tool_sequence.diverges_at`, unmet obligations), then
   `understudy benchmarks rigor <dir>` → `rigor-report.md` — the ABC
   attestation (oracle solvability, floors, calibration, contract
   complexity, anomalies, contamination provenance; honest UNKNOWN rows for
   unchecked items). Bootstrap CIs per `docs/benchmark-rigor.md`.
7. **Regression after code edits.** When the fix was to the user's app, run
   the `app_replay` arm via [`../replay-app-harness/SKILL.md`](../replay-app-harness/SKILL.md)
   — same frozen tasks, current code, rows never feed calibration.

## Daemon lifecycle (executor + desktop)

- **Check first**: `ps`/events for a live `runs execute` watcher; the first
  stderr line prints `executor version <v> (pid <n>)`. A live foreign claim
  is respected; a dead claim is taken over (staleness takeover).
- **Start**: `understudy runs execute --benchmark <dir> --watch` in the
  background; single-pass (no `--watch`) for one drain. Stop safely by
  killing the watcher between polls — requests are re-claimable; in-flight
  rollouts past the timeout become anomaly rows, never silent hangs.
- **Desktop app daemon** (separate thing — local model serving, not the run
  queue): `understudy daemon status` pid-checks and health-probes
  `~/.understudy/agent-card.json`; then `understudy desktop capabilities` /
  `status` / `model|slot|download|chat` verbs. See
  [`reference.md`](reference.md) for what the app covers vs headless CLI.

## Output Standard

End with: benchmark dir and stage (proposed/promoted); ledger state (reviews,
auto-accepts, feedback); calibration verdict (incumbent gate, null/spam floors,
suspects); runs queued/executed and by which executor version; result type
(validation, oracle, live, app-replay); artifact paths written
(`calibration.json`, `rigor-report.md`, `rows-*.jsonl`); and one recommended
next command.
