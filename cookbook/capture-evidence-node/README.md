# Capture Evidence Node Cookbook

This synthetic fixture shows the first workload capability: find a local AI-ish
application surface, capture metadata, and produce local evidence artifacts
without provider calls.

Run from this repo:

```sh
understudy capture-evidence check --repo cookbook/capture-evidence-node
understudy capture-evidence workload-card --repo cookbook/capture-evidence-node
```

Expected artifacts:

```text
.understudy/capture-evidence/check.json
.understudy/workload-discovery/workload-card.json
```

The fixture has a local test command and a tiny synthetic eval file so agents
can identify a harness and candidate eval input without reading private data.
