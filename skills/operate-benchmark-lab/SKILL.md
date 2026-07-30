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
- **Trust posture, not per-call dialogs.** Spend-adjacent shapes (multi-arm
  or multi-rollout runs, implicit all-task runs, experiment
  approval/verdict patches) consult the one-time posture in
  `~/.understudy/trust.json` (`understudy trust set`, levels `local_sandbox`
  < `bounded_experiments` < `hosted_ops`). At `bounded_experiments`+ they
  proceed with a visible one-line notice (arm count, rough cost) — surface
  that notice to the user, then keep moving. Below that, the guard returns
  the one action to offer (`understudy trust set bounded_experiments`);
  `confirm: true` after explicit in-chat consent stays a per-call escape
  hatch. There is NO default spend cap: the posture's
  `allow_spend_usd_per_run` is an opt-in generous stop-loss (warn at 1x with
  a recorded `spend_warning`; hard stop only at 2x with `spend_stop`).
- **Local arms are machine-aware.** On predicted OOM (onboarding profile /
  memory probe) or a serve failure, the executor runs the arm on the gateway
  base model and records it — `arm_fallback` event plus `fallback_reason` on
  every row. Report the fallback; never present a fallen-back arm as a local
  measurement.
- **One executor per benchmark dir.** Before starting `runs execute --watch`,
  check for a live claim (`claimed_by` on the request, `executor_version` on
  events) — a stale watcher built before a feature landed is the classic
  corruption hazard; new requests carry `requires:[...]` so old executors skip
  them with `run_unsupported` instead of running them bare.
- Reviews and feedback are append-only ledgers; never edit
  `reviews.jsonl`/`feedback.jsonl` lines in place. Generated tasks are born
  accepted (review-policy `default_decision: "accept"`) — `reviews.jsonl`
  carries explicit overrides only. `apply_auto_accepts` matters only for
  benchmarks opted into `default_decision: "pending"`, and is itself the
  explicit user action — invoke it only when the developer asked.
- Honest reporting only: anomaly rows (`rollout_timeout`,
  `app_replay_unobserved`, structural sentinels) are excluded from aggregates
  but reported, never fabricated as scores. Overlapping CIs are a tie.
- **Verifier-only changes regrade, never rerun.** When only the verifier
  group changed (gold, contract, rubric, metric config — a MINOR bump),
  re-score the existing trajectories; queueing fresh rollouts for a verifier
  fix wastes gateway money and destroys comparability. Rerun is reserved for
  env-group (MAJOR) changes.
- **Fixture-test every verifier before trusting it.** One known-valid result
  must pass and one plausible-but-wrong result must fail. A verifier that has
  never rejected a wrong answer has not been tested; do not regrade or
  calibrate against it.

## The lifecycle

0. **Intake (dropped workloads).** When the user drops a folder or file into
   the chat (or names a local path), `profile_workload` scans it locally
   (payloads unread, nothing leaves the machine) and lists
   foundry-consumable dataset candidates. Discuss what the workload is,
   confirm the dataset and label/input columns with the user, then
   `from_dataset` compiles it into a PROPOSED benchmark (review-pending,
   `executable: false`) whose tasks land in the review inbox. Never queue a
   run from an intake — the user reviews the proposal first (step 2).
0.5. **Interview before bulk authoring.** Never batch-author tasks straight
   from an intake or trace corpus. First, from the trace clusters, propose
   **2–3 capability directions**, each as a card: **Name** (the capability
   being measured), **Example** (one concrete task drawn from the traces),
   **Tests** (what the verifier would check), **Needs** (dependencies —
   services, fixtures, tools the environment must supply). The user picks a
   direction, then approves a posture **per dependency**: `live` (real
   service; usually wrong for a benchmark), `frozen` (recorded responses), or
   `simulated` (seeded synthetic implementation). Then build **one task
   first**: run it end to end and audit *both* trajectories — the agent's
   (did the environment answer sensibly, did the task make sense) and the
   verifier's (did scoring reflect what actually happened). Fixture-test the
   verifier (one valid pass, one plausible-wrong fail — see Safety Gates).
   Only after that pilot task survives audit do you batch-author the rest.
1. **Build.** Captured traces → `understudy traces build-benchmark`, then
   `understudy traces author-tasks` (gateway) for legible task definitions.
   The generated environment already ships the fixtures pre/post split
   (candidate-readable `fixtures.json` vs scorer-only `gold.json`) and the
   tiered gold-leakage audit (tier 1 verbatim findings, tier 2 fuzzy
   advisory) recorded in `manifest.leakage_audit` — read it, don't re-derive.
2. **Review (born accepted).** `list_benchmarks` → `read_benchmark` →
   `read_task`. Generated tasks are accepted by default — nothing to apply.
   `read_benchmark` returns each task's `effective_decision` plus
   `attention_flags` (low confidence, self-check, incumbent-failed, schema
   conflict, anomaly): work the flagged tasks, tweaking via `submit_feedback`
   or overriding via `submit_review`
   (`reject | needs_more | restrict`, or `accept` to re-accept an overridden
   task; newest line per task wins). `apply_auto_accepts` exists only for
   benchmarks running `review-policy.json` `default_decision: "pending"`
   (the old explicit-accept flow).
   Task or environment wrong? `submit_feedback` appends the ledger entry and
   returns the regenerate-env handoff (`understudy traces regenerate-env`).
3. **Promote and calibrate.** Gate promotion on
   `understudy benchmarks rigor <dir> --ci` (nonzero exit = findings to fix
   first), then `understudy traces promote` unlocks full runs.
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

## Versioning lifecycle (rerun / regrade / reuse)

Every task carries an optional semver `version` plus `content_hashes`
(`env_sha256`, `verifier_sha256`, `meta_sha256`) — three canonical-JSON
sha256 hashes over the field groups defined in `docs/benchmark-rigor.md`.
The contract (mirrors Harbor's model):

| Changed group | Bump | Consequence |
| --- | --- | --- |
| env (instruction, fixtures, tool surface, seed, unknown fields) | MAJOR | **rerun** — old trajectories are invalid |
| verifier (gold refs, contract/rubric, metric config) | MINOR | **regrade** — trajectories stand, re-score them |
| meta (title, docs, tags) | PATCH | **reuse** — existing rows as-is |

Benchmark-level `version` is the max bump across tasks (added tasks = MAJOR,
removed = MINOR). Every bump appends one
`understudy.benchmark_version.v1` line to `versions.jsonl` (append-only
sidecar; records the bump, per-task reasons, splits hash, contamination
status).

Operate it with three verbs:

- **`understudy runs regrade --benchmark <dir> [--run <id>] [--task <id>...]
  [--dry-run]`** — verifier-only change: re-scores retained trajectory
  evidence offline against the CURRENT verifier and writes fresh rows under
  `<run>-regrade-<n>` (source-run provenance, original cost/latency
  preserved), then appends one MINOR `versions.jsonl` line for the regraded
  tasks so the superseded source rows go stale instead of double-counting
  next to their regrades. Never queues rollouts, never spends gateway
  money. If you're about to rerun after a gold/rubric fix, stop — regrade
  instead.
- **`understudy benchmarks upgrade <dir> --against <old-benchmark.json>`** —
  diffs the current manifest against the archived previous one and prints
  the minimal plan first: which task ids **rerun**, which **regrade**, which
  **reuse**, and the resulting version bump; then appends one
  `versions.jsonl` line (`--dry-run` skips the append). Nothing executes;
  `--queue --model <id>` writes run requests for the rerun set only.
- **`understudy benchmarks rigor <dir>... --ci`** — the gate before
  `understudy traces promote` and before publishing any new version: exits
  nonzero on hard findings (floors exceeded, oracle unsolved, verbatim
  leakage, contamination) instead of just writing the report; UNKNOWN is
  fatal only with `--strict`. Run it in the upgrade path too — a version
  bump that fails rigor does not promote (`traces promote` enforces this;
  `--override-rigor <reason>` is recorded in the promotion record).

**Leaderboard staleness.** A row is stale when it predates the newest
breaking bump for its task (MAJOR or MINOR line in `versions.jsonl`; rows
without `created_at` are conservatively stale). MAJOR means **stale —
rerun** (the trajectory itself is invalid); MINOR means **stale — regrade**
(trajectory reusable, score not); PATCH-only changes leave rows current.
Report stale rows the honest-reporting way: excluded from headline
aggregates, counted and named, never silently dropped or silently included.

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

End with: benchmark dir and stage (proposed/promoted); **current benchmark
version** (semver, from the manifest / last `versions.jsonl` line) and
**stale-row status** (rows counted by current / stale-regrade / stale-rerun,
and whether any stale rows sit in a headline aggregate); ledger state
(reviews, auto-accepts, feedback); calibration verdict (incumbent gate,
null/spam floors, suspects); runs queued/executed and by which executor
version; result type (validation, oracle, live, app-replay); artifact paths
written (`calibration.json`, `rigor-report.md`, `rows-*.jsonl`,
`versions.jsonl`); and one recommended next command.
