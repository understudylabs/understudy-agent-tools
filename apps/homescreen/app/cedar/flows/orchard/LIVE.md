# Orchard live Workflow view

Orchard remains a static Tauri/Next export. A read-only sidecar keeps the Train
API key and run capability out of the browser and forwards only the canonical,
redacted `understudy.experiment-event.v1` stream.

The sidecar validates every upstream event against the vendored canonical JSON
Schema and verifies its SHA-256 against
`schemas/understudy-train/manifest.json` before listening. Its `/healthz`
response exposes the contract bundle and event-schema hashes so a cutover
receipt can bind Orchard to the same platform contract consumed by executors.

Run the sidecar on the same monitored host as Orchard:

```bash
ORCHARD_TRAIN_API_URL=https://train.example \
ORCHARD_EXPERIMENT_ID=exp-123 \
ORCHARD_TRAIN_API_KEY=... \
ORCHARD_EXPERIMENT_RUN_TOKEN=... \
ORCHARD_VIEWER_TOKEN=<short-lived-experiment-scoped-read-token> \
ORCHARD_ALLOWED_ORIGIN=https://spark-host.tailnet.ts.net \
bun --cwd apps/homescreen run orchard:workflow-proxy
```

Set `NEXT_PUBLIC_ORCHARD_EVENT_PROXY_URL` at homescreen build time when the
sidecar is not available at `http://127.0.0.1:1431`. Set the matching
`NEXT_PUBLIC_ORCHARD_VIEWER_TOKEN`, an explicit
`NEXT_PUBLIC_ORCHARD_QUALITY_METRIC`, and
`NEXT_PUBLIC_ORCHARD_QUALITY_DIRECTION=higher`. The viewer token is a
short-lived, read-only capability scoped to this experiment; it is not a Train
API key and must be rotated with each published viewer build. Lower-is-better
metrics remain unscored until the renderer supports directional frontiers.
Missing origins and missing viewer authorization fail closed. The sidecar is not a
controller: it cannot submit, approve, cancel, or mutate experiments and stores
no state. Its cursor is supplied by the browser on each request.
