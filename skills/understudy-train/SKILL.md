---
name: understudy-train
description: Prepare local training handoffs for SFT, preference data, RL trajectories, LoRA adapters, or hosted training jobs.
metadata:
  understudy:
    mode: interactive
    safety: approval-required
    cli_required: true
---

# Train

Use when the user asks about fine-tuning, adapters, SFT, preference data, RL,
or hosted training.

Workflow:

1. Confirm a measured baseline and failure taxonomy exist.
2. Export local training records with split IDs and provenance.
3. Keep validation and test rows out of training.
4. Hash local adapter artifacts before promotion.
5. Treat hosted jobs as explicit approval-required actions.

Training is a handoff until the user approves spend/upload.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Do not upload data or start hosted training without explicit upload approval,
training approval, and a budget cap in the current thread.
