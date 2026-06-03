---
name: understudy-demo
description: Replay-first demo path for explaining the Understudy replacement loop without live keys, uploads, or provider spend.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: true
---

# Understudy Demo

Use this when the user is new, wants a demo, or wants to understand the product
shape before running live work.

Workflow:

1. Run a local doctor check.
2. Use bundled or synthetic examples only.
3. Show the replacement loop: baseline, candidate, quality delta, cost delta,
   failure clusters, and next action.
4. Offer a live evaluation only after the replay is understood.

Do not ask for provider keys before showing the local path unless the user
explicitly skips replay.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Default to local-only, no-upload, no-spend work. Use bundled or synthetic
examples only.
