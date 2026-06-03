---
name: understudy-optimize
description: Improve a measured workload using prompt, routing, repair, or candidate-search steps while protecting holdout evidence.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: true
---

# Optimize

Use only after a baseline exists.

Workflow:

1. Preserve the holdout split for measurement only.
2. Start with cheap interventions: prompt repair, renderer repair, parsing,
   routing, and context trimming.
3. Promote a candidate only with repeatable command, metric delta, cost delta,
   fallback route, and demotion trigger.
4. Treat failed screens as experiment inputs, not dead ends.

Do not claim replacement readiness from train-only or validation-only lift.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Never tune on validation or held-out test data. Keep live calls, uploads, and
hosted optimization behind explicit approval, a budget cap, and a reviewed
dry-run artifact.
