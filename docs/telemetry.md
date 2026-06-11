# Telemetry

Understudy Agent Tools emits a small authenticated CLI telemetry stream after a
developer signs in. The goal is to understand whether a developer or coding
agent reaches useful Understudy inference.

No telemetry is sent before credentials exist. Local-only capture, scan, doctor,
skills and optimizer dry-run commands do not require auth and do not
send telemetry unless they call an authenticated command path.

Disable telemetry with:

```sh
UNDERSTUDY_TELEMETRY=0
```

The CLI discloses this state directly: `understudy login` prints a one-line
notice on success, and `understudy status` shows a `telemetry` line (and a
`telemetry_enabled` field under `--json`).

## Destination

Events are sent to the configured Understudy gateway:

```text
POST /v1/agent/events
```

The platform forwards accepted events to product analytics. The CLI never sends
events directly to PostHog.

## Data Boundary

Telemetry must not include prompts, completions, traces, source snippets,
datasets, private repo paths, provider keys, secret values, or local model
metadata.

Allowed fields are categorical or operational:

- event name and event version;
- anonymous install id from `~/.understudy/telemetry.json`;
- CLI version (from `package.json`);
- platform and architecture;
- org id, project slug, user id, and signup intent id when already known from
  credentials/config;
- command category, exit code, duration, and result counts.

Secret-shaped string values are stripped before sending.

## Events

See [`analytics/cli-events.md`](analytics/cli-events.md).
