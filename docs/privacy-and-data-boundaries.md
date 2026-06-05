# Privacy And Data Boundaries

Understudy Agent Tools are local-first by default.

By default, the CLI and skills do not upload files, call providers, inspect
secret values, download models, or submit hosted jobs. After authentication,
the CLI may send bounded product telemetry as documented in
[`telemetry.md`](telemetry.md); set `UNDERSTUDY_TELEMETRY=0` to disable it.

## Data Classes

| Data class | Examples | Default handling |
| --- | --- | --- |
| Source metadata | repo-relative paths, file sizes, signal line numbers | may be written locally under `.understudy/` |
| Source snippets | code fragments, prompt builders, parser logic | do not print, upload, or commit without approval |
| Prompt bodies | system prompts, messages, templates | local-only unless explicitly approved |
| Completions | model outputs, judge outputs, failed rows | local-only unless explicitly approved |
| Traces | request/response payloads, spans, usage rows | metadata-only by default |
| Eval rows | JSONL, CSV, YAML, golden fixtures | local-only until a redaction and split plan exists |
| Secrets | API keys, tokens, credentials, local env files | never ask for chat-pasted values; never print values |
| Local model artifacts | downloaded weights, adapters, caches | download only with explicit approval |

## Boundary Contract

Before any live provider call, upload, hosted job, model download, benchmark
submission, training handoff, or public claim, require:

- exact data class or artifact path;
- destination provider or hosted surface;
- budget cap or download size when relevant;
- dry-run, preview, or local artifact path;
- retention expectation when the destination documents one;
- explicit approval in the current thread.

Configured provider keys are local machine state. They are not permission to
spend.

## Trace And Proxy Rules

Trace capture and proxy work should start with metadata: route, model, timing,
token counts, schema status, and error class. Raw prompts, completions, tool
payloads, source snippets, and eval rows require opt-in handling.

## Never Collected By Default

- API key values;
- raw prompt bodies;
- raw completions;
- private trace payloads;
- source snippets;
- private repo paths;
- customer names or domains;
- prompts, completions, traces, source snippets, datasets, private repo paths,
  provider keys, secret values, or local model metadata in telemetry.
