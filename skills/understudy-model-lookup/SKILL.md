---
name: understudy-model-lookup
description: Inspect model availability, artifact metadata, runner compatibility, and local-vs-remote route choices before benchmarking.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Model Lookup

Use before choosing a runner or claiming a model cannot work.

Workflow:

1. Inspect model card, config, tokenizer, architecture, modality, and
   quantization metadata.
2. Match the artifact to a runner: local, MLX, llama.cpp, OpenAI-compatible,
   provider API, or hosted endpoint.
3. Run a tiny smoke before benchmarking.
4. Report catalog facts separately from measured results.

Check adapter, parser, context-window, token-cap, and route mismatches before
blaming the model.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Model lookup is not benchmark approval. Do not upload prompts, traces,
datasets, or model outputs while checking capabilities.
