---
name: adapter-portfolio
description: Use when registering training adapters, recording dev or sealed-holdout evidence, or deciding whether a candidate adapter is safe to promote without forgetting earlier adapters.
license: MIT
allowed-tools: Bash, Read, Write
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: true
---

# Adapter Portfolio

Use this skill to maintain a local portfolio of training adapters and make
promotion decisions from measured evidence. The portfolio is a training and
evaluation registry; it is not the serving placement registry.

This deliverable is a verifier/contract for the unified Workflow runtime. Its
step is pure and idempotent; it is not a controller, poller, queue, daemon, or
second run-state database.

## Resolve CLI

Build the CLI before using the local checkout:

```bash
npm run build
understudy adapter-portfolio --help
```

The default registry is `~/.understudy/adapter-portfolio.json`. For a
repository-local or test registry, pass `--registry-path <path>` or set
`UNDERSTUDY_ADAPTER_PORTFOLIO`.

## Workflow

1. Initialize policy with `adapter-portfolio init`.
2. Register each candidate with its base model, method, suite, and sealed
   holdout identity.
3. Mark it ready with `adapter-portfolio candidate <name>`.
4. Record dev evidence before recording holdout evidence.
5. Record base and previously promoted adapter holdout references.
6. Record transfer rechecks with the new candidate in `--loaded-adapters`.
7. Run `adapter-portfolio gate <name>`.
8. Promote only with `adapter-portfolio promote <name>` after the gate passes.

Evidence rows are append-only. Correct a bad measurement by recording a new
row, not by editing or deleting an old row.

## Safety Gates

- Never use a holdout row as training input.
- A candidate must be in `candidate` status; draft and already-promoted
  adapters cannot bypass the lifecycle.
- Dev and holdout scores must satisfy the configured thresholds and lift over
  the best recorded base score when a base score exists.
- The candidate holdout hash and row count must match its sealed identity.
- Dev must be recorded strictly before holdout.
- Promotion requires transfer rechecks for the base on every relevant suite
  and each previously promoted adapter on its own suite.
- A transfer recheck must include the candidate in `loaded_adapters` and may
  not regress its reference beyond `max_regression`.
- There is no force-promotion option.
- Evidence `notes` must be a redacted summary only and is capped at 500
  characters. Never include raw traces, prompts, labels, credentials, or
  weights.

See [`reference.md`](reference.md) for the evidence matching rules and a
complete command recipe and the Workflow step/artifact contract.
