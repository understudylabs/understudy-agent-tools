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

## Intake

1. Inspect the requested model id, artifact path, adapter path, provider route,
   runner, quantization, context-window need, modality, and hardware limits.
2. Separate public catalog facts, local artifact metadata, and measured smoke
   results.
3. Check tokenizer, architecture, config, license, quantization, adapter base,
   tool-call support, structured-output support, and context limit.
4. Run the smallest local status, manifest, or dry-run route command.
5. Summarize compatibility before proposing paid, hosted, or upload steps.

## Flow

1. Check local CLI health and lookup surfaces:

```sh
run_understudy --help
run_understudy model --help
```

2. Inspect cached or local model metadata:

```sh
run_understudy model lookup --local --dry-run
```

3. If evaluating a route, verify route shape without sending workload payloads:

```sh
run_understudy model route --dry-run --local
```

4. If a model seems incompatible, check parser, adapter, tokenizer,
   architecture, quantization, context window, token cap, modality, and route
   mismatch before blaming model quality.

5. Read generated artifacts under:

```text
.understudy/model-lookup/
```

6. Recommend the next measured step only after lookup evidence is clear.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - detailed command matrix, artifact contract,
  and interpretation rules.
- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md)
  - measured comparison after compatibility is established.
- [`../understudy-train/SKILL.md`](../understudy-train/SKILL.md)
  - adapter and training handoff checks.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- catalog facts, local metadata, compatibility result, and caveats;
- approval-gated next step, if any;
- one recommended command.
