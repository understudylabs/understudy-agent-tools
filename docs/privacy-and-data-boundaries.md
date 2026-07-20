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
| Desktop chat images | screenshots and other supported image attachments | private app-data files addressed by content hash; SQLite stores references only |
| Traces | request/response payloads, spans, usage rows | metadata-only by default |
| Supervision correction exports | user requests, student partials, supervisor reasons, teacher continuations, tool results, human labels | explicit local CLI export only; owner-only immutable files; never telemetry |
| Remote supervision advisories | bounded user request, student partial, decision phase, pre-decision tool results, tool-round policy, supervisor action/reason/source | off by default; destination-bound Desktop consent or `--confirm-remote`; teacher output and system prompts excluded |
| Dataset and eval rows | JSON, JSONL, CSV, spreadsheets, golden fixtures | local-only unless explicitly dropped into Desktop analysis or approved for training |
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

## Desktop Dataset Analysis

Dropping one supported dataset into Desktop is the explicit action that starts
Pi analysis through the active model shown in the model picker. Desktop decodes
the file locally first. Small datasets may be sent in full; larger text files
and workbooks are reduced to a deterministic, context-bounded representation
with field names and representative records. The UI streams the analysis stage
and names the model used. Dataset analysis does not authorize a hosted training
job, model deployment, or training budget; those remain separate actions.

## Trace And Proxy Rules

Trace capture and proxy work should start with metadata: route, model, timing,
token counts, schema status, and error class. Raw prompts, completions, tool
payloads, source snippets, and eval rows require opt-in handling.

Hosted capture CLI commands keep the same boundary. `understudy captures list`
and `understudy captures get` print redacted summaries only: payload-bearing
fields are represented as present/absent booleans. `understudy captures export`
writes redacted metadata by default. Full capture export requires
`--include-payload --yes`, writes to a file, and must not print raw prompts,
completions, or tool payloads to stdout.

Gateway probes are explicit live calls. BYOK provider keys are read only from an
environment variable named by `--byok-env`; they are not requested in chat, not
persisted, and not printed.

## Desktop Chat Storage

Desktop chat history stays under the operating system's private app-data
directory. Image bytes are validated, capped at 8 MB each, written atomically
with owner-only permissions on Unix, and referenced from SQLite by SHA-256
content ID. Reopening a chat hydrates only bounded previews. Starting a new chat
deletes the previous session's image directory on a best-effort basis; removing
the desktop app-data directory deletes chat history and its attachments
together.

## Supervision Correction Exports

`understudy desktop supervision export` is an explicit local action. It reads
the running desktop's authenticated loopback API and writes correction-pair
JSONL plus aggregate metrics under `~/.understudy/exports/supervision/` by
default. The files are content-addressed, owner-only on Unix, and never replace
different existing content. They can contain raw prompts, model outputs, tool
results, supervisor responses, and human judgments. The command prints only
artifact paths, hashes, counts, and aggregate metrics; it performs no upload and
sends none of the exported content through telemetry.
The reader is bounded to recent local evidence for memory safety. Both the
review desk and exported metrics disclose invalid, missing, incomplete, and
truncated evidence counts instead of silently treating a bounded window as the
entire ledger.

## Remote Supervision Advisories

The optional GLM second opinion is advisory and off by default. Enabling it in
Desktop names an exact provider, project, and workload and discloses the fields
that leave the Mac. Changing that route revokes the previous consent. The CLI
equivalent requires `--confirm-remote`; live judge evaluation additionally
requires `--confirm-spend` and a positive command budget.

Each unique intervention sends only bounded evidence available at the decision
moment: the user request, small-model partial, up to eight bounded tool results,
whether the decision occurred during streaming or after generation ended,
tool-round count and limit, and the supervisor action, reason, and reason source.
It never sends the teacher continuation or system prompt. The exact bounded
evidence, route identity, expected and served model, usage, parsed advisory, and
human judgment of the advisory are stored in owner-only content-addressed files
under `~/.understudy/supervision-tiebreaker/`. They are never telemetry.

An unavailable gateway or offline machine records an advisory error without
blocking the local review desk or changing the human label. Human intervention
labels remain the source of truth.

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
