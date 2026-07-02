---
name: watch-logs
description: Use when a developer wants an always-on ops watcher over logs, command output, or endpoints — "every five minutes look at my logs and tell me what's wrong", "watch this log file and flag anomalies", "review my events on a schedule without burning tokens". Deterministic hash-gated triggers fire a cheap model review only on change, and every review is captured as an eval row for a future fine-tune.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Watch Logs

Stand up a scheduled log/event review that is cheap by construction: a
deterministic trigger script snapshots the watched sources, hashes them, and
only when the hash **changes** does an inexpensive LLM review fire. The review
itself is a small, well-bounded workload — summarize what changed, cite lines,
say "nothing wrong" honestly — sized so a tiny open model (Gemma 2B class)
could eventually serve it. Every review is recorded from day one as an
`understudy.eval_result.v1` row, so the workload accumulates training-grade
evidence without any training now.

## When to use

The developer wants recurring "look at my logs/events and tell me what's
wrong" monitoring. This skill owns the watcher loop: interview → config →
deterministic trigger → gated review → eval-row capture. For turning existing
LLM traces into evals use [`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md);
for building a frozen eval from the accumulated reviews use
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md); for eventually
distilling the review onto a small model use
[`../distill-classifier/SKILL.md`](../distill-classifier/SKILL.md).

## Safety Gates

- **Deterministic gate before any spend.** Never wire a scheduler directly to a
  model call. The trigger script must run first; a review fires only on exit
  code 1 (changed). Unchanged state costs zero tokens.
- **Logs may contain secrets.** Snapshots stay local under
  `~/.understudy/watch-logs/`. Before any *remote* review route (gateway or
  provider), confirm with the developer what the logs can contain and prefer a
  local model slot for sensitive logs; never upload raw snapshots anywhere.
- **Approve the review route and spend bound once, up front** (model, route,
  max tokens, cadence). The cron/launchd job then runs unattended inside that
  bound. No new routes or models without re-approval.
- **Command sources run arbitrary shell.** Only put commands in the watch
  config that the developer typed or explicitly approved; show the final
  config before installing any schedule.
- **Honest reviews only.** The prompt contract requires "nothing wrong" when
  nothing is wrong, and citations for every claimed anomaly. Do not tune the
  prompt toward always finding something.

## Flow

1. **Interview.** Establish, in the developer's words: which sources to watch
   (log file paths/globs, command outputs such as a `curl` health probe),
   the cadence (default: every 5 minutes), and what "wrong" means for this
   workload (error patterns, silence, restarts, latency lines, unexpected
   states). Question bank and config mapping in [`reference.md`](reference.md).

2. **Write the watch config** to `~/.understudy/watch-logs/<watch-id>.json`
   (schema in [`reference.md`](reference.md)) and dry-run the trigger:

   ```sh
   node skills/watch-logs/scripts/watch-logs.mjs check \
     --config ~/.understudy/watch-logs/ops.json --json
   ```

   Exit 0 = unchanged, 1 = changed (a snapshot of exactly what changed is
   written under `~/.understudy/watch-logs/snapshots/`), 2 = error. The first
   run always exits 1 (`first_run: true`) — treat it as the baseline review.

3. **Wire the scheduler.** cron or launchd invokes `check`; only exit code 1
   proceeds to the review step. Copy-paste wiring (including the exit-code-2
   guard so errors alert instead of silently reviewing) is in
   [`reference.md`](reference.md).

4. **Run the gated review.** Send the snapshot's changed content through the
   approved route using the prompt template in [`reference.md`](reference.md):
   a local slot per [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md)
   (private, $0), or a cheap catalog model through
   [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md)
   (always `stream: true`). The review must return strict JSON: a verdict
   (`nothing-wrong` | `anomaly`), a summary, and per-anomaly cited lines.

5. **Record the eval row.** Pipe the review result back through the helper so
   it lands as an `understudy.eval_result.v1` row in
   `~/.understudy/watch-logs/reviews/reviews.jsonl`:

   ```sh
   node skills/watch-logs/scripts/watch-logs.mjs record --row review.json
   ```

   Rows start `status: "unscored"` (no gold labels yet); when the developer
   later marks reviews right/wrong, scored rows make this a frozen eval and a
   fine-tune corpus. Field mapping in [`reference.md`](reference.md).

6. **Surface anomalies.** Deliver `anomaly` verdicts wherever the developer
   asked (terminal, notification hook, issue); `nothing-wrong` verdicts stay
   in the JSONL as evidence, not noise.

## Output Standard

End with: the watch config path and sources; the cadence and scheduler entry
installed (or the command left for the developer to install); the approved
review route, model, and spend bound; where snapshots and review rows live;
and the graduation trigger — once enough scored rows accumulate, route to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md) and
[`../distill-classifier/SKILL.md`](../distill-classifier/SKILL.md) to move the
review onto a small local model.
