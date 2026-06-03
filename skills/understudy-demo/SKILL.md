---
name: understudy-demo
description: Use when a developer wants a first-run Understudy demo that scans a local repo for AI workload candidates before any provider spend.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: true
---

# Understudy Demo

Use this skill when the developer asks for a demo, first run, product
walkthrough, or quick explanation of the Understudy replacement loop.

The preferred first value moment is local repo workload discovery: point
Understudy at the developer's repo, find likely AI workloads, and produce a
local Workload Card draft. Bundled fixture replay is a fallback when no local
repo is available.

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

Use local static inspection, bundled examples, or synthetic examples only. Do
not ask for provider keys before showing a local repo scan or fixture replay
unless the developer explicitly skips local discovery.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

## Intake

1. Confirm the local repo path to inspect. Default to the current working
   directory if the developer is already inside a repo.
2. Inspect local CLI availability and demo commands.
3. Run the smallest no-spend static scan before proposing live work.
4. If no repo is available, fall back to a bundled or synthetic fixture.

## Flow

1. Check the local CLI:

```sh
run_understudy --help
```

2. Inspect demo help:

```sh
run_understudy demo --help
```

3. Scan the local repo for AI workload candidates:

```sh
run_understudy demo scan --repo .
```

This writes under:

```text
.understudy/demo/
```

4. Review the top candidates. Look for provider/model usage, prompts, eval
   harnesses, latency/cost hints, qualitative review needs, or trace capture
   points.

5. Create the first local Workload Card draft:

```sh
run_understudy demo plan --repo .
```

6. Explain the replacement loop using only generated local evidence:
   workload candidate, inferred baseline, candidate routes, quality signal,
   cost or latency signal, stakeholder review surface, and next action.

7. Offer a live evaluation only after the local scan is understood and the
   developer approves the provider, budget cap, and data class.

8. If no candidate is found, use a bundled synthetic fixture repo or ask the
   developer which local code path contains AI calls. Do not pretend an empty
   scan proves there is no workload.

## References

Load deeper material only when needed:

- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) for
  real workload comparisons.
- [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md)
  for local key setup after the replay path.
- [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md)
  for candidate availability or compatibility questions.
- [`../../examples/repos/ai-search-app/README.md`](../../examples/repos/ai-search-app/README.md)
  for the public synthetic repo journey when no local workload is available.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
