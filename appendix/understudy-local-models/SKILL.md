---
name: understudy-local-models
description: Use when checking MLX, Apple Silicon, Ollama, llama.cpp, Transformers, or other local model runners before local inference or route comparison.
metadata:
  understudy:
    mode: interactive
    safety: local-only
    cli_required: true
---

# Understudy Local Models

Use this skill when the developer asks whether a workload can run locally, how
to use MLX on Apple Silicon, whether a quantized model fits local hardware, or
how to compare a local candidate against a hosted route.

Do not use this skill to claim model quality. Route measured comparisons to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) after the
local runner passes a smoke check.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload prompts, traces, source files, datasets, outputs, local model
artifacts, repo paths, provider keys, or private notes unless the developer
explicitly approves that exact action in the current thread.

Local inference readiness is not evaluation evidence. A successful runner smoke
only proves that the model loads and returns output on the current machine.

Before any live provider call, hosted fallback, remote model download, or
benchmark submission, require:

- named provider, registry, or hosted surface;
- estimated download size or spend cap;
- exact artifacts or data class being sent;
- reviewed dry-run or preview artifact;
- visible output path under `.understudy/`.

## Intake

1. Identify the runner: MLX, Ollama, llama.cpp, Transformers, vLLM, local
   OpenAI-compatible server, or unknown.
2. Inspect hardware limits: OS, CPU/GPU, Apple Silicon generation, memory,
   disk, Python version, and whether Metal acceleration is available.
3. Inspect model requirements: architecture, parameter count, quantization,
   context window, tokenizer, adapter base, license, and expected modality.
4. Separate readiness checks from benchmark claims.
5. Prefer a synthetic prompt or bundled fixture for the first smoke.

## Flow

1. Check local-model command availability:

```sh
run_understudy local-models --help
```

2. Inspect local runner readiness without loading private workload data:

```sh
run_understudy local-models doctor --local --dry-run
```

3. Inspect model metadata before running inference:

```sh
run_understudy model lookup --local --dry-run
```

4. If a local route is being compared against hosted models, validate the
   route shape without sending workload payloads:

```sh
run_understudy model route --dry-run --local
```

5. Run only a synthetic or bundled-fixture smoke first. Record startup time,
   first-token latency, tokens per second, memory pressure, context limit,
   output shape, and any fallback path.

6. If the smoke passes, route measured quality or latency comparison to:

```sh
run_understudy evaluate run --dry-run --local
```

7. Read generated artifacts under:

```text
.understudy/local-models/
.understudy/model-lookup/
```

## Runner Notes

- MLX: prefer Apple Silicon checks, memory fit, quantization support, and
  adapter compatibility before running prompts.
- Ollama: treat installed model names as local machine state, not public
  availability evidence.
- llama.cpp: verify quantization, context length, chat template, and Metal
  acceleration separately.
- Transformers: verify device placement and tokenizer compatibility before
  judging speed or quality.
- Local OpenAI-compatible servers: route through the local proxy skill when
  app wiring, base URL, or trace capture is the primary task.

## Output Standard

End with:

- runner and hardware inspected;
- model artifact or model id inspected;
- artifact paths created or read;
- result type: dry-run, fixture smoke, local inference, replay, or live;
- readiness result, latency notes, memory caveats, and unsupported assumptions;
- approval-gated next step, if any;
- one recommended command.
