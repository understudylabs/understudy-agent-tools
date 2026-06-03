---
name: understudy-publish-results
description: Prepare public-safe result summaries from local Understudy artifacts without leaking private prompts, traces, outputs, datasets, or customer context.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: true
---

# Understudy Publish Results

Use this skill when the developer asks to publish, share, announce, package, or
summarize Understudy results for a public audience.

Do not use this skill to generate private customer updates, investor claims, or
hosted deployment reports. Route measurement questions to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) first if
the result has not been measured.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function before running CLI
commands.

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

Public result drafts must not include customer names, domains, raw prompts,
raw completions, trace rows, private repo paths, internal runbook names, or
unverified current vendor claims.

## Intake

1. Inspect the local result artifacts and identify the measured workload,
   baseline, candidate, sample size, split boundary, metric names, costs, and
   caveats.
2. Separate measured facts from interpretation, recommendations, and planned
   next steps.
3. Check whether the target surface is public, partner-facing, internal, or
   private. Use the strictest audience if unclear.
4. Run the smallest no-spend command that confirms the skill library and local
   workspace are visible:

```sh
run_understudy skills
```

## Flow

1. Read only the artifacts needed for the requested summary.
2. Redact or generalize private identifiers before drafting.
3. Preserve numeric evidence when it is safe: metric deltas, cost deltas,
   latency ranges, sample sizes, and date of measurement.
4. Label result type explicitly: dry-run, replay, fake-provider, validation,
   heldout, or live.
5. Include failure cases and limitations when they change the interpretation.
6. End with one concrete next command or approval-gated next step.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
