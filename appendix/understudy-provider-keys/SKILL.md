---
name: understudy-provider-keys
description: Safely guide provider-key setup without asking users to paste secrets into chat.
metadata:
  understudy:
    mode: interactive
    safety: secrets-handling
    cli_required: true
---

# Understudy Provider Keys

Use this skill when the developer needs to check, configure, rotate, or verify
local provider credentials for Fireworks, OpenRouter, Prime Intellect, Tinker,
GCP/Vertex, AWS/Bedrock, Lilac, Understudy inference, or a direct frontier API
route such as OpenAI, Anthropic, or Gemini.

Do not use this skill to change app routing or proxy behavior. Route local
gateway work to
[`../understudy-local-proxy/SKILL.md`](../understudy-local-proxy/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Never let an API key appear in chat, tool output, logs, examples, or committed
files. If a key is exposed, stop and guide rotation.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

## Intake

1. Identify the provider, SDK, and local runtime that needs credentials.
2. Check whether credentials are present by name only. Do not print values.
3. Prefer terminal prompts, local env files, operating-system secret storage, or
   the developer's secret manager.
4. Summarize missing or conflicting key names without exposing values.

## Flow

1. Check available credential commands:

```sh
run_understudy keys --help
```

2. If a doctor command exists, run it in redacted mode:

```sh
run_understudy keys doctor --redacted
```

3. If the CLI does not expose key helpers, inspect only environment variable
   names and file paths. Safe examples include:

```text
ANTHROPIC_API_KEY=<present or missing>
OPENAI_API_KEY=<present or missing>
GOOGLE_API_KEY=<present or missing>
FIREWORKS_API_KEY=<present or missing>
OPENROUTER_API_KEY=<present or missing>
PRIME_API_KEY=<present or missing>
TINKER_API_KEY=<present or missing>
GOOGLE_APPLICATION_CREDENTIALS=<present or missing path only>
AWS_PROFILE=<present or missing>
LILAC_API_KEY=<present or missing>
UNDERSTUDY_API_KEY=<present or missing>
```

4. If a key is missing, ask the developer to enter it through a terminal prompt
   or their secret manager. Do not request the value in chat.

5. If a key was exposed, stop normal work and recommend rotation for that
   provider before continuing.

6. Verify configuration with a no-spend status check first. A real model call
   requires explicit approval and a budget cap.

7. Read generated artifacts under:

```text
.understudy/keys/
.understudy/provider-checks/
```

8. Summarize provider readiness as present, missing, conflicting, or exposed.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
