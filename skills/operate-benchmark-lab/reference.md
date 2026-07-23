# operate-benchmark-lab reference

Command matrix, artifact map, daemon details, and the desktop-app boundary.
Source of truth: `docs/agent-operator-surface.md`, `docs/app-harness.md`,
`docs/benchmark-rigor.md`, `src/commands/runs.ts`, `src/commands/traces.ts`,
`src/commands/benchmarks.ts`, `src/commands/daemon.ts`,
`src/commands/desktop.ts`, `src/run-executor.ts`.

## MCP tools (`understudy benchmarks mcp`)

Ten tools, all backed by the same compiled modules as the hub API (no forked
format logic):

| Tool | What it does |
| --- | --- |
| `list_benchmarks` | benchmark dirs under the roots: stage, task counts, review summary |
| `read_benchmark` | manifest + tasks with latest review decisions and score summaries |
| `read_task` | prompt/statement, outcome contract, world-model summary, review history |
| `read_rollout` | trajectory from `runs/live/<run>-<model>.jsonl` + per-obligation scoring |
| `diff_rollouts` | side-by-side obligations + `tool_sequence.diverges_at` between two runs |
| `submit_review` | appends `understudy.benchmark_review.v1` to `reviews.jsonl` |
| `apply_auto_accepts` | appends `source:"auto"` accepts per `review-policy.json` (defaults when absent) |
| `submit_feedback` | appends `understudy.task_feedback.v1` to `feedback.jsonl`; returns the regenerate-env handoff |
| `queue_run` | writes `understudy.run_request.v1` into `runs/queue/` — never executes |
| `run_status` | request status, row summary, and the calibration block (incumbent gate + trivial floors) |

Guardrails baked in: `queue_run` on a *proposed* benchmark accepts exactly one
accepted task with a validated environment; full runs require
`understudy traces promote`. Read-only roots (demo/fixture) reject writes.
Journals are read with line caps; malformed lines are skipped, never fatal.

## CLI verbs

```sh
# Build
understudy traces build-benchmark ...            # compile traces → benchmark dir + env
understudy traces author-tasks --benchmark <dir> # LLM task authoring (gateway); --compare-models, --overview
understudy traces regenerate-env --benchmark <dir>   # rebuild env (also the feedback handoff)
understudy traces promote ...                    # proposed → promoted (unlocks full runs)

# Queue + execute
understudy runs list --benchmark <dir>
understudy runs queue --benchmark <dir> --models <ids> \
  [--split train|dev|holdout|all] [--tasks <ids>] [--rollouts N] \
  [--incumbent <ids>] [--rollout-timeout <s>] \
  [--prompt-override <arm_label>=<model>=<suffix-file>]   # repeatable
understudy runs execute --benchmark <dir> [--watch] [--interval 30] \
  [--concurrency 2] [--rollout-timeout <s>] [--runner verifiers|oracle]

# Versioning (rerun / regrade / reuse)
understudy runs regrade --benchmark <dir> \
  [--run <run_id>] [--task <id>...] [--dry-run]  # verifier-only (MINOR) change: re-score retained
                                                 # trajectories offline, write fresh rows under
                                                 # <run>-regrade-<n> + one MINOR versions.jsonl line
                                                 # (source rows go stale); never queues rollouts
understudy benchmarks upgrade <dir> --against <old-benchmark.json> \
  [--note <text>] [--dry-run] [--queue --model <id> --rollouts N]
                                                 # diff current manifest vs the archived previous one;
                                                 # print the minimal rerun/regrade/reuse plan, append one
                                                 # versions.jsonl line; --queue writes run_requests for
                                                 # the rerun set only (queue-only, never executes)

# Rigor + operator surface
understudy benchmarks rigor <dir>...             # writes rigor-report.md in each dir
understudy benchmarks rigor <dir>... --ci \
  [--strict] [--changed-only [--base <ref>]]     # gate mode: exit 1 on any hard FAIL (UNKNOWN fatal
                                                 # only with --strict); run before promote/publish
understudy benchmarks mcp [--root <dir>...]

# App instrumentation sanity (before capture-based building)
understudy instrument --check [--json]
```

`--runner oracle` is deterministic and zero-cost (offline validation);
`verifiers` runs the real generated environment via uv with gateway creds from
env or `~/.understudy/credentials.json`. Trivial arms are queued on the request
(`trivial_arms: ["null_agent", "spam_agent"]` via the hub/MCP body) and run one
rollout per task. `app_replay: true` requests always use the app-harness
runner regardless of `--runner`; `incumbent_models` is rejected on them.

## Artifacts in a benchmark dir

| File | Meaning |
| --- | --- |
| `benchmark.json`, `tasks.jsonl` | manifest + task contracts |
| `understudy_trace_env/servers/fixtures.json` | candidate-readable **pre-state only** (task_id-tagged) |
| `gold.json` | scorer-side expected post-state — never served to a candidate |
| `manifest.leakage_audit` | tiered gold-leakage audit: tier 1 verbatim = findings, tier 2 fuzzy = advisory; report-only |
| `reviews.jsonl` | append-only review ledger; newest line per task wins |
| `review-policy.json` | `understudy.review_policy.v1` auto-accept bar (optional; defaults apply) |
| `feedback.jsonl` | `understudy.task_feedback.v1` entries → regenerate-env handoff |
| `runs/queue/*.json` | `understudy.run_request.v1` requests (with `claimed_by`, `requires`, `unsupported`) |
| `runs/live/<run>-<model>.jsonl` | per-arm rollout journals |
| `rows-*.jsonl` | scored rows (`arm_kind`: model / `null_agent` / `spam_agent` / `prompt_override` label / `app_replay`) |
| `calibration.json` | incumbent gate + `null_floor`/`spam_floor` (`floor_exceeded` when > 5%, with `passed_task_ids`) |
| `rigor-report.md` | ABC attestation from `understudy benchmarks rigor` (UNKNOWN rows are honest gaps) |
| `versions.jsonl` | append-only `understudy.benchmark_version.v1` lines — one per version bump, with per-task `task_bumps` (major/minor/patch + reason), splits hash, contamination status |
| `app-harness.json` | `understudy.app_harness.v1` sidecar for app-replay runs |

Interpreting calibration: `floor_exceeded: true` means a do-nothing or
ritual-tool-calling agent clears too many tasks — fix those tasks' contracts
before any candidate claim. Tasks the incumbent fails on rerun are flagged
**suspect** (`incumbent_failed`): either the task is wrong or the incumbent
capture drifted; review them, don't average over them.

## Task semver and content hashes

Each manifest task may carry (additive, optional) `version` (semver string)
and `content_hashes` — `env_sha256`, `verifier_sha256`, `meta_sha256`:
canonical-JSON (recursively sorted keys) sha256 over three field groups
(`computeTaskContentHashes` / `classifyTaskChange` / `diffBenchmarkManifests`
in `src/benchmark.ts`; full table in `docs/benchmark-rigor.md`):

- **env → MAJOR → rerun**: instruction/prompt, fixture and environment refs,
  tool surface, seed — plus **all unknown fields** (conservative default:
  an unrecognized change forces a rerun, never a silent reuse).
- **verifier → MINOR → regrade**: gold refs, verifier/contract/rubric,
  metric config.
- **meta → PATCH → reuse**: title, description, docs, tags.

`version` and `content_hashes` themselves are excluded from hashing.
Benchmark-level version = max bump across tasks; added tasks count MAJOR,
removed MINOR. Leaderboard staleness is currently computed from each row's
`created_at` against the newest breaking (MAJOR/MINOR) bump per task in
`versions.jsonl` — rows older than the bump are stale (excluded from
headline aggregates, counted and named, restorable via the include toggle);
rows missing `created_at` are conservatively stale. Stamping rows with the
exact task version/content hash they ran against is the planned tightening.

## Executor daemon details

- Every request carries `requires: [...]` against
  `EXECUTOR_CAPABILITIES = ["trivial_arms", "calibration", "rollout_timeout",
  "prompt_overrides", "app_replay"]`; an executor missing a capability records
  `run_unsupported` (with its `executor_version` and the `missing` list) and
  skips — it never runs the request with fields silently dropped.
- Claiming: the executor writes `claimed_by` (pid, host, nonce,
  `executor_version`) atomically and re-reads to confirm; a live foreign
  claim is respected, a dead one is taken over. Diagnose stale-watcher
  incidents from the first stderr line (`executor version <v> (pid <n>)`)
  and the `executor_version` stamped on every event.
- Stop: SIGTERM/SIGINT the watcher; queued requests stay claimable, and any
  rollout past its timeout is killed into a `rollout_timeout` anomaly row.
- Events stream to stderr; stdout stays parseable JSON.

## Desktop app: what it is, how to get it, what it covers

**Distribution (verified in-repo + on GitHub, 2026-07):** Understudy Desktop
is a Tauri app released as GitHub Releases on
`understudylabs/understudy-agent-tools`, tags `desktop-vX.Y.Z-mvp`. Each
release ships `Understudy_<version>_aarch64.dmg` (macOS Apple Silicon — the
only platform currently built), `Understudy.app.tar.gz` + `.sig`, and
`latest.json` (the Tauri v2 updater manifest; canonical endpoint
`https://github.com/understudylabs/understudy-agent-tools/releases/latest/download/latest.json`).
To find/download it:

```sh
gh release list -R understudylabs/understudy-agent-tools --limit 5
gh release download <tag> -R understudylabs/understudy-agent-tools -p '*.dmg'
```

The app self-updates via the signed updater once installed. There is no
standalone download website in this repo — do not invent one; point users at
the GitHub Releases page. No Intel-mac, Windows, or Linux builds exist yet;
say so rather than guessing.

**What the app manages vs headless CLI:**

- The **app** owns the local daemon (`~/.understudy/agent-card.json`), warm
  MLX model slots, model downloads, canonical chat runs, and supervision —
  drive it with `understudy daemon status` then the `understudy desktop`
  verbs (`contract`, `capabilities`, `status`, `model list|catalog`,
  `slot list|add|assign`, `download list|start`, `chat`, `run cancel|events`,
  `supervision export`, `tool-proof ...`).
- The **benchmark lab is fully headless**: build/review/queue/execute/rigor
  need only the CLI and (optionally) the MCP server — no desktop app
  required. Use the app's daemon only when a run needs a locally served
  model endpoint (see `run-local-model-lab`).
