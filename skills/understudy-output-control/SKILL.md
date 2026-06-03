---
name: understudy-output-control
description: Use when failures may be parser, JSON/schema, tool-call, formatting, or output-contract issues rather than model reasoning quality.
metadata:
  understudy:
    mode: diagnostic
    safety: local-first
    cli_required: true
---

# Understudy Output Control

Use this skill before optimization or training when the apparent failure could
be caused by output format, parser behavior, tool-call wire format, schema
strictness, JSON validity, or repair loops.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

## Flow

1. Separate reasoning failures from output-contract failures.
2. Check JSON validity, schema validation, tool-call shape, parser strictness,
   repair rate, and whether prefill or constrained decoding changed behavior.
3. Compare contract validity and task correctness separately.
4. Try parser, renderer, schema, or prompt-format fixes before training.
5. Route true quality regressions to evaluation or optimization.

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
for the evidence ladder and training-last rule.

## Output Standard

End with:

- failure class;
- contract-validity evidence;
- task-quality evidence;
- next local repair or eval command;
- approval-gated next step, if any.
