---
name: understudy-provider-keys
description: Safely guide provider-key setup without asking users to paste secrets into chat.
metadata:
  understudy:
    mode: interactive
    safety: secrets-handling
    cli_required: true
---

# Provider Keys

Use when a workflow needs Anthropic, OpenAI, Gemini, Fireworks, Together,
Hugging Face, or another provider.

Rules:

- Do not ask users to paste keys into chat.
- Prefer terminal prompts, local env files, or the user's secret manager.
- Check whether keys are present before asking for new ones.
- Never print key values.
- Keep provider spend behind explicit approval and a budget cap.

## Resolve CLI

Open and read `../_resources/cli-bootstrap.md`, then define the shared
`run_understudy` shell function before running CLI commands.

## Safety Gates

Never let an API key appear in chat, tool output, logs, examples, or committed
files. If a key is exposed, stop and guide rotation.
