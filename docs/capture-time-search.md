# Find captures near an execution

When your application database has an execution timestamp but no Understudy
request or trace ID, search for candidate captures in that time window. These
examples use invented project names and timestamps.

```sh
understudy captures list --project rehearsal --workload classify \
  --from 2026-06-07T10:14:00Z --to 2026-06-07T10:16:00Z --json
```

Both timestamps must include a timezone: `Z` for UTC or an explicit offset such
as `2026-06-07T06:14:00-04:00`, with at most millisecond precision. The CLI
normalizes them to UTC. `--from` is
inclusive and `--to` is exclusive. The window must be in the past and no longer
than 24 hours. An explicit workload and selected project are required.

Time search follows index pages automatically and returns all matching indexed
references, up to 100,000. Larger results fail with guidance to narrow the
window instead of returning a partial success. Omit `--limit` and `--cursor`
when supplying timestamps; those flags continue to control ordinary listings.

## Inspect and select

Each result contains `request_id` and `captured_at`. Here `captured_at` means
the gateway's **request-start time**, as indicated by
`timestamp_basis: "request_start"` in JSON. It is not the object upload time or
the application's execution-completion time. If your database records completion,
start the search earlier to include the calls that led up to it. The command
matches request starts inside the window; it does not infer execution overlap.

Inspect a candidate using the same scope:

```sh
understudy captures get <request-id> --project rehearsal --workload classify --json
```

This returns the existing redacted summary, including a trace ID when one is
present. Time search itself does not fetch payloads to discover trace IDs,
models, or user identities. An indexed reference is not proof that its payload
is still available; detail lookup can report an unavailable capture.

Concurrent executions can share a time window. Select candidates using the
evidence available to your application; a timestamp match alone does not prove
which user or agent produced a call. Save the chosen request IDs, one per line,
in a private file such as `.understudy/request-ids.txt`, then export them:

```sh
understudy captures export --project rehearsal --workload classify \
  --request-ids-file .understudy/request-ids.txt \
  --out .understudy/selected-captures --include-payload --yes
```

Full-payload export remains explicit and writes private files. A time search
does not expand matches to calls outside the window or automatically choose a
whole trace.

## Search scope and freshness

The hosted index currently serves 24-hour windows. The CLI requests a covering
index window, filters its metadata to the exact requested times, and stops when
the ordered results reach the end. For recent searches, it may need to read
earlier index pages from the latest 24 hours. It does not enumerate the account's
lifetime captures or download unrelated capture objects.

JSON includes the requested `window`, the covering `index_window`,
`ingestion_cutoff`, `pages`, and `scanned_count`. Searches use the hosted index's
production environment. Other request environments are not included.

Pages share the same ingestion snapshot. `truncated: false` means all matching
references in that snapshot were returned; it does not guarantee every request
was captured or indexed. Recent events can arrive later. Run a fresh search to
include them.
