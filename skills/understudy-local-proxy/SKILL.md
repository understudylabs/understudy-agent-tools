---
name: understudy-local-proxy
description: Set up or inspect a local OpenAI-compatible proxy and trace-capture path without uploading payloads.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Local Proxy

Use when the user wants to route an app through a local gateway or capture
traces.

Workflow:

1. Inspect the app's current model client configuration.
2. Identify SDK style and base URL fields.
3. Start with fixture/local mode.
4. Verify one request path before recommending production routing.
5. Keep trace storage local unless the user explicitly uploads.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Never ask for secrets in chat. Keep trace capture local by default and verify
the app's current client wiring before changing configuration.
