---
name: understudy-demo
description: Use when a developer wants a first-run Understudy demo or product walkthrough using local replay, bundled fixtures, and no provider spend.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: true
---

# Understudy Demo

Use this skill when the developer asks for a demo, first run, product
walkthrough, or quick explanation of the Understudy replacement loop.

Do not use this skill for a real workload comparison after the developer has
provided prompts, traces, datasets, or eval artifacts. Route those requests to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, stop and explain that the Understudy CLI is not
available in the current shell. Do not invent install commands.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Use bundled or synthetic examples only. Do not ask for provider keys before
showing a local replay unless the developer explicitly skips the replay path.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

## Intake

1. Confirm whether the developer wants a product demo or a real workload run.
2. Inspect local CLI availability and any bundled demo commands.
3. Run the smallest no-spend status or replay command before proposing live
   work.

## Flow

1. Check the local CLI:

```sh
run_understudy --help
```

2. Prefer a bundled demo, doctor, or replay command exposed by the installed
   CLI. If the exact demo command is not obvious, inspect help first:

```sh
run_understudy demo --help
```

3. Run a local replay or fixture-only demo that writes under:

```text
.understudy/demo/
```

4. Explain the replacement loop using only generated or bundled evidence:
   baseline, candidate, quality signal, cost or latency signal, failure
   clusters, and next action.

5. Offer a live evaluation only after the local replay is understood and the
   developer approves the provider, budget cap, and data class.

## References

Load deeper material only when needed:

- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) for
  real workload comparisons.
- [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md)
  for local key setup after the replay path.
- [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md)
  for candidate availability or compatibility questions.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
