---
name: understudy-evaluate
description: Evaluate prompts, traces, datasets, or model candidates with local-first comparisons and explicit split boundaries.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: true
---

# Evaluate

Use this when the user has a workload and wants to compare model quality,
latency, reliability, or cost.

Workflow:

1. Identify source material: prompts, traces, eval rows, repo scripts, or
   synthetic fixtures.
2. Define train, validation, and test boundaries before optimization.
3. Run the smallest useful local or no-spend smoke.
4. Report metric definitions, sample size, cost, latency, and known caveats.
5. Escalate to provider calls only with explicit approval and a budget cap.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.
