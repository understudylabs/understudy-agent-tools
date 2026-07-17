# Background Ops — Concrete Async Pattern

Concrete mechanics for running blocking operations (model-server startup, weight
downloads, eval runs) without blocking the agent. Every skill that launches one
of these should follow this pattern so the agent stays interactive during
wall-clock waits.

The high-level rule is in [`engagement-and-pacing.md`](engagement-and-pacing.md)
§ 2 ("Background the slow thing — first") and § 3 ("Fill the wall-clock with
useful work"). This doc adds the shell/API mechanics.

## 1. Launch a blocking op as a background process

Use whichever form matches the agent's execution surface:

**Shell background (`&`) — simplest, works in any bash-compatible shell:**

```bash
# model server startup — weight download happens here, do not wait on it
mlx_lm.server --model <mlx-community/repo> --port 8080 \
  >> .understudy/local-model-lab/server.log 2>&1 &
SERVER_PID=$!
echo "mlx_lm.server PID $SERVER_PID — log: .understudy/local-model-lab/server.log"

# understudy run eval — long eval run, do not block on it
understudy run -- <eval-command> \
  >> .understudy/runs/eval.log 2>&1 &
RUN_PID=$!
echo "understudy run PID $RUN_PID — log: .understudy/runs/eval.log"
```

**Agent background task (preferred when the agent platform supports it):**

Use the agent's native `run_background_task` / background-task tool. Record the
task ID so you can poll status and surface a notification on completion — do not
silently poll in a loop. Announce the ETA before starting, then move on.

**nohup (when the shell session may close):**

```bash
nohup mlx_lm.server --model <repo> --port 8080 \
  >> .understudy/local-model-lab/server.log 2>&1 &
```

## 2. Poll for readiness / completion

### mlx_lm.server — poll `/v1/models` until the server answers

```bash
timeout 600 bash -c \
  'until curl -sf http://localhost:8080/v1/models >/dev/null; do sleep 5; done' \
  || { echo "mlx_lm.server failed to become ready within 10 minutes"; exit 1; }
echo "server ready"
```

- First response may be delayed by weight loading (seconds to minutes depending
  on model size and disk speed). Poll at 5-second intervals.
- A successful `/v1/models` response means weights are loaded and the endpoint
  accepts requests — only then run the eval or smoke-test.

### `understudy run` — tail the log and check exit code

```bash
# tail output while other work runs
tail -f .understudy/runs/eval.log &
TAIL_PID=$!

# wait for the background run to finish (2-hour wall-clock cap)
SECONDS=0
while kill -0 "$RUN_PID" 2>/dev/null; do
  sleep 5
  if [ "$SECONDS" -ge 7200 ]; then
    echo "understudy run timed out after 2 hours — check .understudy/runs/eval.log"
    kill "$RUN_PID" 2>/dev/null
    kill $TAIL_PID 2>/dev/null
    exit 1
  fi
done
wait "$RUN_PID"
EXIT=$?
kill $TAIL_PID 2>/dev/null

if [ $EXIT -eq 0 ]; then
  echo "understudy run succeeded — inspect artifacts"
else
  echo "understudy run exited $EXIT — check .understudy/runs/eval.log"; exit $EXIT
fi
```

When using a native agent background task, use the platform's status/notify
mechanism instead of `wait` — do not poll `status` in a tight loop.

### General download (hf download, pip install, brew install)

Same pattern: send to background with `&`, log to a file, poll completion via
`wait $PID` or a native task status check. Never leave the agent blocked on a
progress bar.

## 3. What to do while waiting

Don't go idle. While the background op runs, advance the loop steps that don't
depend on it:

- **Cost-model the alternatives.** Compute what candidate models cost at the
  user's real request volume — pull fresh per-token prices, label assumptions.
  See [`engagement-and-pacing.md`](engagement-and-pacing.md) § 3.
- **Pull benchmark / spec context.** Look up published benchmarks, context
  windows, licenses, and hardware fit for candidate models
  ([`open-model-spotlight.md`](open-model-spotlight.md)).
- **Prepare next-step artifacts.** Scaffold the evidence record, draft the eval
  splits, or write the claim-packet skeleton
  ([`../skills/understudy/reference.md`](../skills/understudy/reference.md)).
- **Profile hardware / tooling.** Detect installed runtimes, free disk, unified
  memory while the download runs — so you have the facts ready when the download
  lands.

Surface a notification when the background op completes; do not silently continue
without telling the user.
