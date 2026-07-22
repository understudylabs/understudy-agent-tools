# Local trace-envelope normalization

The public boundary is `.understudy/captures/`. Acquisition, credentials,
tenant selection, and privileged administration are outside this skill.

Preserve the original local record while normalizing request ID; `ts` or
`created_at`; `workload_id` or legacy `placement_id`; requested and upstream
model separately; customer request; upstream request; and `response_body` or
legacy `customer_response_body`.

Bodies may be objects or bounded layers of JSON-encoded strings. Streamed SSE
must be parsed event-by-event and reassembled without discarding ordering,
event types, tool-call deltas, stop reasons, or original representation.

Each normalized row retains system, ordered messages, tools, settings, response
messages/calls, aliases and warnings, source pointer/hash, and raw request and
response representations. Unknown schema versions are unsupported until
inspected; never silently coerce them.

Use `--max-age-days` when the benchmark represents current behavior. Missing or
invalid timestamps are excluded, and an empty fresh window fails rather than
falling back to stale captures.
