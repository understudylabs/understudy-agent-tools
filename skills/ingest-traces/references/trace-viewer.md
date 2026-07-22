# Local trace viewer

Use the bundled viewer when a developer wants to inspect one trace as an
execution timeline with model requests, provider responses, system prompts,
tool definitions, tool calls, tool results, and raw capture metadata.

## Build

```sh
understudy traces build-viewer \
  --source .understudy/captures \
  --trace-id <trace-id> \
  --output .understudy/trace-viewer/<trace-id>
```

If the source contains exactly one non-empty `trace_id`, omit `--trace-id`.
When multiple trace IDs are present the command fails closed rather than
combining unrelated executions. `--source` accepts a capture file or a
directory containing `.json`, `.jsonl`, or `.ndjson` files.

Open the emitted `index.html` directly. It loads the sibling `trace-data.js`,
so no local server, dependency install, or network request is required.

## Output contract

```text
.understudy/trace-viewer/<trace-id>/
├── index.html       # reusable public template
├── trace-data.js    # private capture payloads for this rendering
└── manifest.json    # counts, paths, trace selection, privacy flags
```

The public template lives at
[`../templates/trace-viewer/index.html`](../templates/trace-viewer/index.html).
The CLI always copies it into the private output directory; never edit the
template to embed a real trace.

The viewer understands Understudy capture envelope aliases for timestamps,
workloads, models, request bodies, response bodies, and normalized trace rows.
It renders all values with DOM text nodes rather than capture-controlled HTML.

## Privacy

The viewer is local-only but not redacted. `trace-data.js` can contain raw
system prompts, messages, tool arguments/results, responses, identifiers, and
other customer payloads. The command writes viewer artifacts with owner-only
permissions and marks them `must_not_commit`; keep the output under
`.understudy/`, do not attach it to issues or pull requests, and do not host it
without an explicit data-sharing decision.

Use screenshots or written summaries only after redacting customer content.
The viewer is an inspection surface, not evidence that a trace is complete:
model-call captures may continue arriving, and a W3C `traceparent` does not
carry a root-span completion signal.
