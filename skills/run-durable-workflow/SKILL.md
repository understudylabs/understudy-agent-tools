---
name: run-durable-workflow
description: Use when an Understudy task needs a pre-orchestrated durable workflow template with pause/resume, approval gates, substeps, or long-running Python adapter execution.
metadata:
  understudy:
    mode: interactive
    safety: approval-gated
    cli_required: true
---

# Run Durable Workflow

Use this worker when a task is too long or stateful for a single CLI command:
GEPA/DSPy optimization, gateway A/B validation, verifier handoff preparation,
or any workflow with approvals, budgets, retries, and artifact review.

The CLI launches packaged templates. Skills still decide whether the workflow
is appropriate and what approval boundary applies.

## Safety Gates

Do not run a workflow that uploads data, calls providers, downloads models,
spends budget, or touches holdout rows unless the developer approves the exact
template, input file, data class, and budget/download bound.

Workflow inputs must use local paths, public fixtures, synthetic fixtures, or
explicitly approved data. Do not include raw prompts, completions, traces,
labels, secrets, or private notes in workflow input JSON unless approved for
that run.

## Resolve CLI

Prefer the installed `understudy` binary. If it is unavailable inside a repo
checkout, run through the package script:

```sh
npm run build
node dist/bin.js workflow list
```

The base CLI does not install Smithers as a hard dependency. If
`understudy workflow run ...` reports that no runner is available, install or
provide a Smithers-compatible runner and pass `--smithers-bin <path>`.

## Flow

1. List packaged templates:

   ```sh
   understudy workflow list
   ```

2. Inspect the skill for the capability being orchestrated. For GEPA/DSPy, read
   [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md) first and
   confirm fresh capture artifacts.

3. Prepare a small workflow input JSON. Keep secrets out; use paths and config
   names instead of values.

4. Dry-run the launch command:

   ```sh
   understudy workflow run optimize-gepa --run-id optimize-smoke --input workflow-input.json --dry-run
   ```

5. After approval, run the template:

   ```sh
   understudy workflow run optimize-gepa --run-id optimize-smoke --input workflow-input.json
   ```

6. Monitor workflow output and local `.understudy/` artifacts. If the workflow
   emits a next command rather than executing it, run that command only after
   the same approval boundary is still satisfied.

## Output Standard

End with:

- workflow template and run id;
- approval boundary and whether execution was approved;
- artifacts inspected or expected;
- current workflow status or next command;
- result type: planned, running, blocked, or completed.
