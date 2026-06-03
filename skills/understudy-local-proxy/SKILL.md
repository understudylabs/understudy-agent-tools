---
name: understudy-local-proxy
description: Set up or inspect a local OpenAI-compatible proxy and trace-capture path without uploading payloads.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Local Proxy

Use this skill when the developer asks to route an app, SDK, CLI, or agent
through a local OpenAI-compatible gateway, inspect base URL wiring, capture
local traces, or verify proxy behavior without uploading payloads.

Do not use this skill for provider API key setup. Route key and secret handling
to [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md).

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

Never ask for secrets in chat. Inspect whether a key reference exists only as a
configuration name or environment variable name; do not print values.

Trace capture must write to local storage by default. Before any live provider
call, hosted route, upload, or benchmark submission, require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifact or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

Provider keys are local machine state, not spend approval.

## Intake

1. Inspect the app's real client wiring, SDK, environment names, and base URL
   settings.
2. Identify whether the app uses OpenAI SDK, Vercel AI SDK, LangChain,
   LiteLLM, direct HTTP, or another OpenAI-compatible client.
3. Run the smallest no-spend local status or doctor command.
4. Summarize the current route before proposing configuration edits.

## Flow

1. Check local proxy support:

```sh
run_understudy proxy --help
```

2. If a doctor or dry-run command is available, run it before touching app
   configuration:

```sh
run_understudy proxy doctor --dry-run
```

3. Inspect the target app for generic client fields such as:

```text
OPENAI_BASE_URL
OPENAI_API_BASE
baseURL
base_url
apiBase
model
```

4. Prefer a fixture, fake-provider, or local replay path for the first request.
   Do not use a configured provider key as permission to make a paid request.

5. Start or validate the proxy only after the target route is understood:

```sh
run_understudy proxy start --help
```

6. Verify one request path end to end. Capture only local metadata needed to
   prove routing, status, latency, and model selection unless the developer
   approves richer trace capture.

7. Read generated artifacts under:

```text
.understudy/proxy/
.understudy/traces/
```

8. Summarize the observed app route, proxy route, result type, and next command.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command.
