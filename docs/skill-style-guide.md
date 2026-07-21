# Understudy Public Skill Style Guide

Public Understudy skills are product UX for agents. They should be short,
safe, and operational.

## Voice

- Direct and concrete.
- No hype, no private sales posture, no internal sprint doctrine.
- Explain what the agent should do, not why Understudy is impressive.
- Prefer "inspect", "run", "read", "summarize", "stop" over vague verbs.

## Shape

Every public skill uses this shape:

1. frontmatter compatible with Agent Skills Spec v1.1;
2. short activation paragraph;
3. `## Resolve CLI` unless `cli_required: false`;
4. `## Safety Gates`;
5. `## Intake`;
6. `## Flow`;
7. `## Output Standard`;
8. optional `## References`.

Target length: 80-120 lines. Put command matrices in `reference.md`.

## Frontmatter

Descriptions are activation-only. Keep under 512 characters.

```yaml
---
name: <capability>   # must match the skill's directory name (validated)
description: Use when...
metadata:
  understudy:
    mode: automatic | interactive | reporting | production
    safety: local-first | approval-required | secrets-handling
    cli_required: true | false
---
```

## Safety Language

Every skill must say which route and data class it touches, what one user action
activates the workflow, and which envelope expansions require another decision.
The canonical policy is
[`privacy-and-data-boundaries.md`](privacy-and-data-boundaries.md).

Use this standard rule:

> A user action that launches a named bounded workflow authorizes its declared
> uploads, provider calls, hosted jobs, evaluation, receipts, and cleanup. Ask
> again only before expanding data, destination, spend, retention, credentials,
> or production impact. Never print, commit, or transmit secret values.

Provider keys are local machine state, not spend approval.

## Public Boundary

Allowed:

- public datasets;
- synthetic fixtures;
- local `.understudy/` artifacts;
- public provider docs and public open-source projects;
- generic approval-gated hosted workflows.

Not allowed:

- customer names, domains, volumes, traces, prompts, labels, or completions;
- internal admin surfaces, identity-provider wiring, storage internals, database
  internals, capacity secrets, or hosted-control details;
- private customer-specific runbooks;
- aggressive internal spend heuristics;
- uncited current claims about vendor pricing, model support, ownership, or API
  behavior.

## Progressive Disclosure

The fat `understudy` skill routes. It should not be a runbook.

Specialist skills should reveal only the next layer:

```text
understudy -> domain skill -> reference.md -> examples/*.sh
```

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
