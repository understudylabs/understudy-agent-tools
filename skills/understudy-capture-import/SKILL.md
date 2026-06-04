---
name: understudy-capture-import
description: Use when finding or importing local AI calls, traces, eval fixtures, prompt files, logs, datasets, or existing benchmark artifacts into an Understudy workflow.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Capture Import

Use this skill when the developer has an existing app, repo, eval suite, trace
store, prompt set, JSONL/CSV, benchmark, log, or dataset and wants Understudy to
turn it into a Workload Card or evaluation plan.

Do not use this skill to evaluate quality yet. Route measured comparisons to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) after the
source, data class, redaction needs, and split boundary are explicit.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not print, paste, upload, summarize, or commit raw prompts, completions,
trace payloads, source snippets, dataset rows, customer names, repo paths,
provider keys, or secrets unless the developer explicitly approves that exact
action in the current thread.

The first pass is metadata-only: path, source kind, byte size, and evidence line
numbers. Reading payload rows, extracting examples, or generating eval fixtures
requires a data-boundary and redaction plan.

## Flow

1. Run a local source scan:

```sh
run_understudy capture-import scan --repo .
```

2. Review `.understudy/capture-import/capture-sources.json`.
3. If payload shape matters, write a bounded local preview:

```sh
run_understudy capture-import preview --repo . --source-id source-001 --limit 25
```

The preview default is 25 records and the cap is 200 records. Records are
written under `.understudy/capture-import/`, not printed to the terminal.
The generated redaction manifest recommends `keep`, `review`, `hash`, or `drop`
per field path, but does not mutate records.

4. Pick one source candidate and classify it:
   - `ai-call-site`
   - `eval-fixture`
   - `prompt-template`
   - `trace-or-log`
   - `jsonl-data`
   - `tabular-data`
   - `markdown-notes`
5. Record data class, redaction needs, split boundary, owner, and approval gates.
6. Create or update a Workload Card before evaluation:

```sh
run_understudy capture-import workload-card --repo . --source-id source-001
```

## Output Standard

End with:

- selected source candidate or reason none was selected;
- data class and redaction needs;
- whether payload reading is still blocked;
- artifact path under `.understudy/capture-import/`;
- recommended next command.
