---
name: understudy-evaluate
description: Use when comparing prompts, traces, datasets, scorers, routes, or model candidates with local-first evaluation evidence.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Evaluate

Use this skill when the developer asks to evaluate a workload or compare
quality, latency, reliability, cost, scorers, prompts, routes, or model
candidates.

Do not use this skill for optimization after a measured baseline exists. Route
those requests to [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
For fine-tuning, SFT, adapter, or training-data requests, route to
[`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work. Prefer local artifacts,
synthetic fixtures, replay data, and dry-run plans before live provider calls.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- reviewed dry-run or preview artifact;
- visible output path under `.understudy/`.

Keep split boundaries explicit. Do not inspect heldout labels or tune prompts,
scorers, renderers, or routes against heldout rows.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - intake checklist, command flow, artifact
  contract, and interpretation rules.
- [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md)
  - model capability and route compatibility checks before benchmarking.
- [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md)
  - post-baseline improvement loop.
