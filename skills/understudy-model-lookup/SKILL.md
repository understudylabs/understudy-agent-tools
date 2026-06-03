---
name: understudy-model-lookup
description: Use when inspecting model availability, metadata, runner compatibility, and route choices before benchmarking.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Model Lookup

Use this skill when the developer asks whether a model, adapter, route, runner,
provider API, local engine, quantization, context window, tokenizer, or
modality can work for a workload.

Do not use this skill to claim quality, replacement readiness, or benchmark
performance. Route measured comparison requests to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work. Model lookup should inspect
local metadata, public model cards, cached manifests, runner help, and dry-run
route plans before any live provider call.

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

Model lookup is not benchmark approval. Do not send prompts, traces, datasets,
or model outputs to providers while checking availability or compatibility.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - intake checklist, command flow, model
  analysis docs, artifact contract, and output standard.
- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md)
  - measured comparison after compatibility is established.
- [`../understudy-train/SKILL.md`](../understudy-train/SKILL.md)
  - adapter and training handoff checks.
