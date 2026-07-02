# Watch Logs Reference

Depth for [`SKILL.md`](SKILL.md): the interview question bank, the watch
config schema, scheduler wiring, the review prompt contract, the eval-row
mapping, and the graduation path to a fine-tuned small model.

## Interview question bank

Ask in the developer's vocabulary; map answers into the config below.

1. **What should be watched?**
   - Log files: exact paths, or a single-directory glob (`/var/log/app/*.log`).
     Wildcards are supported in the basename only.
   - Command outputs: anything printable — `systemctl status app`,
     `docker ps --format ...`, `curl -fsS --max-time 10 <health-endpoint>`.
     HTTP endpoints are watched as `curl` command sources so the trigger
     script itself stays network-free.
2. **How much history matters?** The trigger hashes the last `tail_bytes`
   (default 64 KiB) of each file. High-volume logs may want a bigger tail;
   noisy-but-irrelevant logs a smaller one.
3. **Cadence?** Default every 5 minutes. Faster than 1 minute rarely helps —
   the hash gate already makes idle checks free, but review latency is bounded
   by the model call anyway.
4. **What does "wrong" mean here?** Collect concrete signals: error/panic
   patterns, stack traces, restart loops, silence (a log that *stopped*
   moving also changes state — file size is part of the hash input), status
   codes, latency lines, queue depth. Write these into the prompt's
   "workload-specific signals" block.
5. **What must never leave the machine?** Decides local slot vs gateway route.
6. **Where should anomalies land?** Terminal, notification, issue tracker.

## Watch config schema

`~/.understudy/watch-logs/<watch-id>.json`:

```json
{
  "watch_id": "ops",
  "sources": [
    { "id": "app-log", "type": "file", "path": "/var/log/app/server.log", "tail_bytes": 65536 },
    { "id": "worker-logs", "type": "file", "glob": "/var/log/app/workers/*.log" },
    { "id": "health", "type": "command", "command": "curl -fsS --max-time 10 http://localhost:8080/health", "timeout_ms": 15000 }
  ]
}
```

- `file` sources hash the tail of every matched file, prefixed with path and
  current size — so rotation, truncation, growth, and new/removed matches all
  register as change.
- `command` sources hash `exit code + stdout + stderr`, so a health probe that
  flips from 200 to connection-refused changes state even if it prints nothing.

State lives in `~/.understudy/watch-logs/state/<watch-id>.json`; on change a
payload with the changed sources' full content is written to
`~/.understudy/watch-logs/snapshots/<run-id>.json` for the review step.

## Scheduler wiring

Only exit code 1 may proceed to the review. Exit 2 is an error — alert,
don't review. cron (every 5 minutes):

```sh
*/5 * * * * node /path/to/skills/watch-logs/scripts/watch-logs.mjs check \
  --config "$HOME/.understudy/watch-logs/ops.json" --json \
  >> "$HOME/.understudy/watch-logs/check.log" 2>&1; \
  case $? in 1) /path/to/run-review.sh ;; 2) /path/to/alert-error.sh ;; esac
```

launchd (macOS) — save as
`~/Library/LaunchAgents/com.understudy.watch-logs.ops.plist`, then
`launchctl load` it; point `ProgramArguments` at a small wrapper shell script
containing the same `check → case` pipeline, with `StartInterval` set to `300`.

`run-review.sh` reads the newest snapshot, runs the review call, and pipes the
result JSON to `watch-logs.mjs record`. Keep the whole pipeline idempotent:
one snapshot → at most one review row.

## Review step contract

The review is deliberately a small-model-shaped task: bounded input (only the
changed tails), strict JSON output, honesty required.

**Route.** Local slot first for sensitive logs —
[`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md) stands up
an OpenAI-compatible endpoint (reuse a running desktop-app warm slot when
present). Otherwise a cheap catalog model through
[`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md) —
always `stream: true`, aggregate locally. Record model + route in every row.

**Prompt template** (fill the `{{...}}` blocks; hash the filled system prompt
with sha256 and pass it to `record` as `prompt_sha256` so prompt versions are
traceable across rows):

```text
System:
You are an operations log reviewer. You receive the portions of watched
sources that CHANGED since the last check. Report only what the text
supports. If nothing looks wrong, say so plainly — a correct "nothing wrong"
is a successful review, and inventing problems is a failure.

Workload-specific signals to treat as wrong:
{{signals_from_interview}}

Respond with STRICT JSON only, no prose outside it:
{
  "verdict": "nothing-wrong" | "anomaly",
  "summary": "<one paragraph: what changed and whether it is healthy>",
  "anomalies": [
    { "source_id": "<id>", "line": "<exact quoted line>",
      "note": "<why this is wrong>", "severity": "low" | "medium" | "high" }
  ]
}
Rules: every anomaly must quote an exact line from the input; "verdict":
"anomaly" requires at least one anomaly entry; "nothing-wrong" requires an
empty anomalies array.

User:
Watch: {{watch_id}}   Snapshot: {{snapshot_run_id}}   Time: {{created_at}}
Changed sources:
{{for each changed source: "== <id> ==" + its content}}
```

Cap the review at a small `max_tokens` (the JSON is short) and validate the
JSON before recording; a malformed response is recorded with
`verdict: "review-failed"` (becomes `status: "error"`) so reliability is
measured too, then retried once.

## Eval-row capture

`watch-logs.mjs record` maps a review result onto
[`understudy.eval_result.v1`](../../schemas/understudy.eval_result.v1.schema.json):

| Row field | Source |
| --- | --- |
| `run_id` | `watch-logs:<watch_id>` — the ongoing watch is the run |
| `task_id` | the snapshot `run_id` — one changed snapshot is one task |
| `split` | `"none"` (no split contract yet) |
| `score` / `status` | `null` / `"unscored"` until a human labels the review; a labeled row carries `score` 0..1 and `"ok"`; `review-failed` → `"error"` |
| `model`, `route`, `latency_ms` | from the review call |
| `provenance.harness_sha256` | `prompt_sha256` of the filled system prompt |
| `provenance.artifact_refs` | the snapshot path (the exact model input) |
| `review` (extra field) | `verdict`, `summary`, `anomalies` — v1 allows producer extras |

Input shape for `record` (stdin or `--row file.json`):

```json
{
  "watch_id": "ops",
  "snapshot_id": "ops-2026-07-02T09-05-00-000Z",
  "verdict": "anomaly",
  "summary": "Worker 3 entered a restart loop after the 09:03 deploy.",
  "anomalies": [ { "source_id": "worker-logs", "line": "panic: nil deref", "note": "crash on startup", "severity": "high" } ],
  "model": "gemma-4-e2b", "route": "local", "latency_ms": 840,
  "prompt_sha256": "<sha256>", "snapshot_path": "<path to snapshot json>"
}
```

## Retention and graduation

- Snapshots and `reviews.jsonl` are the training corpus — keep them. If disk
  matters, prune snapshots older than N days *only after* their rows are
  scored; never prune the JSONL.
- Periodically ask the developer to spot-label a batch of rows (was the
  verdict right?). Once a few hundred scored rows exist:
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) freezes them
  into splits, [`../compare-model-sweep/SKILL.md`](../compare-model-sweep/SKILL.md)
  checks how small a model can hold the quality bar, and
  [`../distill-classifier/SKILL.md`](../distill-classifier/SKILL.md) /
  [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md)
  move the review onto a tiny local model — at which point the whole watcher
  runs at zero marginal cost.
