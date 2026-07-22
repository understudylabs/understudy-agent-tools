---
name: replay-app-harness
description: Use when a coding agent has edited a user's LLM app and wants a regression verdict on the frozen benchmark tasks — "did my code change regress the eval", "run my actual app against the benchmark", "author an app-harness.json". Drafts the understudy.app_harness.v1 sidecar from the user's repo, queues an app_replay run, and reads the honest (marked-anomaly, never fabricated) rows.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Replay the user's app on frozen benchmark tasks

Model arms answer "what would model X do?". The `app_replay` arm answers
"what does the user's app, as the code currently exists, do on the same
frozen tasks?" — the regression check to run after editing the user's code.
Full reference: `docs/app-harness.md` in this repo; sidecar schema:
`schemas/understudy.app_harness.v1.schema.json`.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js runs execute --benchmark <benchmark-dir>
```

## Safety Gates

- **The harness launches the user's own code as a subprocess.** Only put
  commands in `app-harness.json` that the developer showed you or approved;
  never invent entrypoints. Show the drafted sidecar and get approval before
  the first run.
- **LLM traffic is pinned to the Understudy gateway.** The executor's
  redirect env vars win over the harness's `env` — do not attempt to route
  around them, and say so if the app hard-codes a provider base URL.
- **The app may mutate real state.** Before queueing, confirm with the
  developer that the entrypoint is replay-safe (test/sandbox mode, no
  production writes). If unsure, do not run it.
- **Honest scoring only.** Never present `app_replay_unobserved` or
  `unscored` rows as passes/failures; report them as unobserved and point at
  the tier-1 boundary in `docs/app-harness.md`.

## Step 1 — Author `app-harness.json` from the user's repo

Read the user's repo and draft the sidecar into the benchmark directory:

1. Find the entrypoint that handles ONE task-shaped request end to end
   (CLI/worker script preferred; long-running HTTP servers are tier 2).
2. Study how the task input reaches it and pick `input_mode`:
   - `argv` — prompt appended as the final argument;
   - `stdin` — one JSON line `{"task_id", "prompt"}`;
   - `http` — author the endpoint template now; it validates but does not
     execute at tier 1 (say so to the user).
   In every mode the app can instead read `UNDERSTUDY_TASK_PROMPT` /
   `UNDERSTUDY_TASK_ID` from the env.
3. Note the SDK shape in `notes` (OpenAI/Anthropic — both base-URL redirect
   vars are injected; see the `instrument` skill).
4. Set `tool_route`: `"gateway_tools"` only if the app's tool layer writes
   `UNDERSTUDY_LIVE_JOURNAL` lines; otherwise `"none"` and tell the user the
   rows will honestly read `app_replay_unobserved` until tier 2.
5. Set `per_task_timeout_seconds` (default 300, max 3600), `cwd`, `command`
   (argv vector), `schema_version: "understudy.app_harness.v1"`,
   `llm_route: "gateway"`.

## Step 2 — Queue and execute

Queue via the hub (`POST /api/runs`) or MCP `queue_run` with
`"app_replay": true` and `models` set to a label for the app (e.g. its name).
The request records `requires: ["app_replay"]` so old executors skip it with
`run_unsupported` instead of corrupting it. Then make sure an executor runs:

```sh
understudy runs execute --benchmark <benchmark-dir> --watch
```

## Step 3 — Read the verdict honestly

- Rows are labeled `arm_kind: "app_replay"` and NEVER feed calibration (an
  app replay is not an incumbent claim).
- Scored rows carry `subscores.runner_app_replay: 1` and went through the
  same contract scorer as every other arm.
- Rows with `anomaly.kind: "app_replay_unobserved"` mean the app finished
  but its tool effects were not observable — report that as "unobserved",
  never as a 0 or a pass.
- Regression verdict = compare app-replay rows on the same frozen task set
  before vs after the code edit; anomalous rows are excluded from aggregates
  but stay visible.
