---
name: export-trace
description: Use for "get this trace", "show every request in this trace", "export these trace IDs", or "download this workload's captures for a day". Resolves explicit traces or a bounded workload window through customer APIs, exports captures privately, and hands local files to the trace viewer or ingest-traces.
---

# Export Trace

Retrieve one explicit hosted trace without scanning the capture catalog. Resolve
its request IDs through the customer trace lookup endpoint, then reuse the
bounded request capture exporter.

For a named workload day rather than explicit trace IDs, use the workload
flow below. For a before/after task comparison, use
[`../ramp-and-verify/references/review-rollout.md`](../ramp-and-verify/references/review-rollout.md).

## Safety Gates

- Treat a bare `trace_id` as authorization for a redacted local summary export,
  not for raw prompts or completions.
- Use `--include-payload --yes` only when the developer explicitly asks for the
  full, raw, or complete trace/captures. Announce that the files may contain
  prompts, completions, and tool payloads before running it.
- Keep outputs under `.understudy/`; never print, paste, commit, or upload trace
  bodies.
- Never ask for API keys in chat. Use existing Understudy credentials and report
  only auth presence or errors.
- Never replace the trace lookup with project-wide capture pagination. If the
  lookup endpoint is unavailable, stop and report the backend dependency.

## Resolve CLI

Prefer the installed `understudy` binary. In this repository checkout:

```sh
npm run build
node dist/bin.js status --json
```

Use `node dist/bin.js` in place of `understudy` below when necessary.

## Explicit trace flow

1. Resolve the project from repo config or an explicit `--project` /
   `--project-id`. Resolve `--workload` only when the developer supplied or
   requested that narrower scope.
2. For redacted metadata, run:

   ```sh
   understudy traces export <trace-id> \
     --project <project> \
     --out .understudy/traces/<trace-id>
   ```

3. For an explicitly requested full trace, run:

   ```sh
   understudy traces export <trace-id> \
     --project <project> \
     --out .understudy/traces/<trace-id> \
     --include-payload --yes
   ```

   For several explicit IDs, put one per line in a private local file and use
   `--trace-ids-file <path>`. Do not use or recreate an unbounded `--all`
   operation.
4. Inspect only metadata artifacts:

   - `trace.json` — `trace_id`, ordered `request_ids`, and export counts;
   - `failed-request-ids.txt` — request captures to retry;
   - `failed-trace-ids.txt` — trace lookups or trace exports to retry;
   - `*.summary.json` or `*.payload.json` — private per-request files.

   Do not print payload file contents. Rerun the same command to resume; completed
   request files are skipped.
5. When the developer asks to inspect the conversation locally, build the
   private viewer:

   ```sh
   understudy traces build-viewer \
     --source .understudy/traces/<trace-id> \
     --trace-id <trace-id> \
     --output .understudy/trace-viewer/<trace-id>
   ```

6. When the developer wants an eval, cost profile, or benchmark from the local
   files, hand off to [`../ingest-traces/SKILL.md`](../ingest-traces/SKILL.md).

## Workload day flow

Resolve one exact organization/project/workload. With authorization for full
payloads, export a completed UTC calendar day:

```sh
understudy traces export --org <org-id> --project-id <project-id> \
  --workload <name-or-id> --date <YYYY-MM-DD> \
  --out .understudy/traces/<run> --include-payload --yes
```

`--last 1d` instead selects the last 24 hours. Inspect `source/summary.json`
and `source/skipped.jsonl`: any skipped capture means some indexed captures
were not materialized. Local hashes prove the saved bytes, not uncaptured
traffic coverage. Never silently present a skipped export as complete.
For arbitrary paired windows and verified request accounting, use the rollout
review flow linked above rather than hand-merging independent day exports.

## Failure Handling

- `404` for one trace: report that the trace is absent from the authorized
  project/workload or that the platform trace lookup has not deployed. Do not
  scan capture history as a fallback.
- `401`/`403`: stop and route auth/project readiness to
  [`../use-understudy-gateway/SKILL.md`](../use-understudy-gateway/SKILL.md).
- A non-empty `failed-request-ids.txt`: report a partial export and rerun the
  same command; do not claim the trace is complete.
- A response with no request IDs or a mismatched `trace_id`: fail closed and
  report the contract violation.

## Output Standard

End with the trace ID, project/workload scope, redacted or full mode, request
count, complete/partial status, private output directory, and one next action:
open the local viewer, retry failures, or route to `ingest-traces`.
