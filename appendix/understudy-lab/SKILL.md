---
name: understudy-lab
description: Use when Understudy work spans multiple runs and needs durable hypotheses, budgets, artifacts, decisions, and next actions.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: false
---

# Understudy Lab

Use this skill when the developer is running a longer experiment loop, comparing
multiple hypotheses, tracking a budget, preserving a decision record, or asking
for a durable research note.

Do not use this skill for a single first-run demo. Route those requests to
[`../understudy-demo/SKILL.md`](../understudy-demo/SKILL.md). Do not use it as a
substitute for workload measurement; route measurement to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

This skill can write a lab note without the CLI.

When a lab note needs current Understudy status, open and read
[`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md), then define
the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, continue with file-based notes only and mark
the CLI check as unavailable.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Lab notes in public repositories must not contain customer names, domains,
private partner identifiers, raw prompts, raw completions, raw traces, secrets,
or private runbook details.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

## Intake

1. Identify the hypothesis, decision, or open question.
2. Inspect the relevant local artifacts before summarizing results.
3. Separate observed results from planned next steps.
4. Record costs, budgets, split boundaries, and commands when available.

## Flow

1. Choose a local note path under:

```text
.understudy/lab/
```

2. If the CLI is available and a status check is relevant, run:

```sh
run_understudy --help
```

3. Write or update a concise note with these fields:

```text
hypothesis:
method:
budget:
data_or_split_boundary:
commands:
artifact_paths:
result:
decision:
next_action:
approval_gates:
```

4. Use anonymized workload labels for reusable public notes. Preserve
non-sensitive measurements such as model version strings, sample sizes, cost,
latency, and metric definitions when they are needed to interpret the result.

5. If the note identifies a new real workload measurement, route the next step
to [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md). If it
identifies a candidate improvement loop, route to
[`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).

## References

Load deeper material only when needed:

- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) for
  measurement and split boundaries.
- [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md) for
  candidate promotion, fallback, and demotion evidence.
- [`../understudy-train/SKILL.md`](../understudy-train/SKILL.md) for training
  handoff notes.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
