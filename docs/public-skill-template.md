# Public Skill Template

```markdown
---
name: understudy-<capability>
description: <One activation-focused sentence. Include trigger nouns/verbs, not the full workflow.>
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy <Capability>

Use this skill when the developer asks to <specific workload shape>, such as
"<trigger phrase>", "<trigger phrase>", or "<trigger phrase>".

Do not use this skill when <clear exclusion>. Route those requests to
[`../understudy-<other>/SKILL.md`](../understudy-<other>/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

## Intake

1. Inspect the real local artifact, repo, report, trace, or workload profile.
2. Run the smallest no-spend status or dry-run command.
3. Summarize current state before proposing paid, hosted, or upload steps.

## Flow

1. Run:

```sh
run_understudy <status-or-doctor-command>
```

2. If local artifacts are missing, run a fixture-only or dry-run command:

```sh
run_understudy <capability> <subcommand> --dry-run
```

3. Read generated artifacts under:

```text
.understudy/<capability>/
```

4. Summarize evidence, limitations, and the next concrete command.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) — detailed command matrix, artifact contract,
  and interpretation rules.
- [`references/<topic>.md`](references/<topic>.md) — optional focused
  sub-playbooks for complex subtopics.

## Examples

Use local-only examples first:

```sh
./examples/<local-example>.sh
```

Examples must write to `.understudy/<capability>/` and must not require
provider keys, uploads, or paid calls by default.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- whether the result is dry-run, replay, fake-provider, validation, or heldout;
- approval-gated next step, if any;
- one recommended command.
```
