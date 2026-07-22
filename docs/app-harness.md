# App replay (tier 1): run the user's own app on frozen benchmark tasks

The model arms in the run executor answer "what would model X do on these
tasks?". The **app_replay** arm answers a different question: "what does the
user's application, *as the code currently exists*, do on the same frozen
tasks?" — the regression check an agent needs after editing the user's code.

- Schema: [`understudy.app_harness.v1`](../schemas/understudy.app_harness.v1.schema.json)
  (`app-harness.json` sidecar in the benchmark directory)
- Runner: `src/app-harness.ts` (`appReplayRunner`), registered additively in
  the executor (`arm_kind: "app_replay"`, capability `"app_replay"`)
- Loop: see "Current-code regression loop" in
  [`agent-operator-surface.md`](agent-operator-surface.md)

## How a rollout works

For each selected task the executor launches the app per the harness:

1. **Env**: parent env + `harness.env`, then (winning last) the
   `/instrument`-style gateway redirect vars — `OPENAI_BASE_URL` →
   `<gateway>/v1`, `ANTHROPIC_BASE_URL` → `<gateway>` (the Anthropic SDK
   appends `/v1` itself), `UNDERSTUDY_API_KEY` / `OPENAI_API_KEY` /
   `ANTHROPIC_API_KEY` set to the gateway key — plus `UNDERSTUDY_TASK_ID`,
   `UNDERSTUDY_TASK_PROMPT`, `UNDERSTUDY_RUN_ID`, and
   `UNDERSTUDY_LIVE_JOURNAL` (the arm's live journal file). The harness
   cannot re-route LLM traffic away from the gateway (`llm_route: "gateway"`
   is the only v1 route).
2. **Input** (`input_mode`):
   - `argv` — the task prompt is appended as the final command argument;
   - `stdin` — one JSON line `{"task_id": ..., "prompt": ...}` on stdin;
   - `http` — schema-valid in v1 (endpoint template with `{task_id}` /
     `{prompt}` placeholders) but **not executable by the tier-1 runner**;
     rollouts return an explicit `app_harness_http_unsupported` error.
3. **Timeout**: the subprocess is SIGKILLed at
   `min(per_task_timeout_seconds, rollout_timeout_seconds)` (default 300s);
   killed rollouts become `rollout_timeout` anomaly rows, never hangs.
4. **Scoring**: journal entries appended during the rollout (`kind: "call"`)
   become the event stream, the app's trimmed stdout the final response, and
   both go through `scoreContract` — the exact scorer every other arm
   (verifiers, oracle, trivial) is judged by. Rows carry
   `subscores.runner_app_replay: 1`.

## What tier 1 can and cannot observe (be precise)

Tier 1 **can** observe:

- launch success/failure, exit code, stderr tail, wall-clock latency;
- the app's stdout (scored as the final response for response obligations);
- any tool call the app (or a tool shim in the app's process) appends to the
  `UNDERSTUDY_LIVE_JOURNAL` file — apps whose tool layer honors the journal
  env var are fully scorable, exactly like the verifiers arm.

Tier 1 **cannot** observe:

- tool calls the app executes internally without writing the journal — the
  gateway sees the LLM *requests/responses* (and captures them for later
  ingestion), but the executor does not yet read tool-call traces back from
  the gateway per rollout;
- HTTP-mode apps (long-running servers) — launch/readiness/POST plumbing is
  tier 2;
- side effects that never flow through LLM tool-calling at all.

When a rollout completes but zero tool events were observed, the row is
recorded honestly: `status: "unscored"`, `score: null`, and the structural
anomaly `{kind: "app_replay_unobserved"}`. Anomalous rows are marked and
excluded from aggregates — never fabricated as 0s or passes. Partial-but-
honest beats fake-complete.

## Queueing an app-replay run

```jsonc
// POST /api/runs (or the MCP queue_run tool) body
{ "models": ["my-app"], "split": "dev", "tasks": "all",
  "rollouts_per_task": 1, "app_replay": true }
```

- `models` entries are **labels** for the app arm (typically the app or route
  name); rows are labeled `arm_kind: "app_replay"`.
- The request records `requires: ["app_replay"]`; an executor without the
  app-replay runner skips it with a `run_unsupported` event instead of
  running it as a model arm.
- `incumbent_models` is rejected on app-replay runs: an app replay is a
  regression check on current code, **not** an incumbent claim, and its rows
  never feed `calibration.json`.
- Execute with `understudy runs execute --benchmark <dir> --watch` (the
  runner is wired in automatically; `--runner` still selects the model-arm
  runner for ordinary requests).

## Authoring `app-harness.json` (a coding agent drafts it from the repo)

1. **Find the entrypoint** that handles one task-shaped request end to end
   (a CLI, a worker script, a test invocation). Prefer a single-shot command
   over a long-running server (HTTP mode is tier 2).
2. **Study how the task input reaches it**: a positional argument → `argv`;
   reads a request object from stdin → `stdin`; only reachable over HTTP →
   author `input_mode: "http"` with the endpoint template now, knowing it
   runs at tier 2. In every mode the app may instead read
   `UNDERSTUDY_TASK_PROMPT` / `UNDERSTUDY_TASK_ID` from the env.
3. **Check the SDK shape** (see the `instrument` skill): the redirect vars
   are injected for both OpenAI- and Anthropic-shape SDKs; note in `notes`
   which one the app uses.
4. **Decide `tool_route`**: `"gateway_tools"` when the app's tool calls are
   observable in the journal (a shim or the app itself writes
   `UNDERSTUDY_LIVE_JOURNAL` lines: `{"kind":"call","tool":...,
   "arguments":...}` / `{"kind":"result",...}`); `"none"` when they are not —
   rows will honestly record `app_replay_unobserved`.
5. **Set `per_task_timeout_seconds`** to a generous single-task budget
   (default 300, max 3600) and `cwd` relative to the benchmark dir or
   absolute (the app's repo root).
6. Validate: the file must satisfy
   `schemas/understudy.app_harness.v1.schema.json`; `readAppHarness` prints
   the exact reasons when it refuses a file.

Example:

```json
{
  "schema_version": "understudy.app_harness.v1",
  "command": ["node", "/Users/me/my-app/scripts/handle-ticket.mjs"],
  "cwd": "/Users/me/my-app",
  "env": { "MY_APP_MODE": "replay" },
  "input_mode": "stdin",
  "per_task_timeout_seconds": 240,
  "llm_route": "gateway",
  "tool_route": "gateway_tools",
  "notes": "OpenAI SDK; tool layer journals via UNDERSTUDY_LIVE_JOURNAL."
}
```

## Tier-2 follow-ups (not in this change)

- Read per-rollout tool-call traces back from the gateway captures so
  `tool_route: "gateway_tools"` needs no in-app journal shim.
- HTTP mode execution: launch the server, wait for readiness, POST the task,
  tear down per rollout (or reuse across a run).
- Cost attribution from gateway usage records (rows currently carry
  `cost: null`).
