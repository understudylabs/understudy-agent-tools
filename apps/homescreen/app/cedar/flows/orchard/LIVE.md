# Orchard live Workflow view

Orchard remains a static Tauri/Next export. A read-only sidecar keeps the Train
API key and run capability out of the browser and forwards only the canonical,
redacted `understudy.experiment-event.v1` stream.

Run the sidecar on the same monitored host as Orchard:

```bash
ORCHARD_TRAIN_API_URL=https://train.example \
ORCHARD_EXPERIMENT_ID=exp-123 \
ORCHARD_TRAIN_API_KEY=... \
ORCHARD_EXPERIMENT_RUN_TOKEN=... \
ORCHARD_ALLOWED_ORIGIN=https://spark-host.tailnet.ts.net \
bun --cwd apps/homescreen run orchard:workflow-proxy
```

Set `NEXT_PUBLIC_ORCHARD_EVENT_PROXY_URL` at homescreen build time when the
sidecar is not available at `http://127.0.0.1:1431`. The sidecar is not a
controller: it cannot submit, approve, cancel, or mutate experiments and stores
no state. Its cursor is supplied by the browser on each request.
