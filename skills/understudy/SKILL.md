---
name: understudy
description: Use when a developer asks to use Understudy, evaluate or optimize an AI workload, prepare training data, run a demo, set up local capture or proxying, or inspect model options. Route to the narrow specialist skill before running commands.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Understudy

Use this skill as the public entrypoint for Understudy. Start here when the
developer names Understudy or asks for help with evaluation, optimization,
training handoff, local proxying, model choice, provider setup, or a first-run
demo.

Do not use this skill as a full runbook. Route to the narrow specialist skill,
then follow that skill's CLI and safety instructions.

## Resolve CLI

Do not resolve the CLI in this routing skill unless the user explicitly asks
for setup status before the intent is clear.

When a routed specialist skill requires the CLI, open and read
[`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md), then define
the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, stop and explain that the Understudy CLI is not
available in the current shell. Do not guess install paths.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- dry-run or preview artifact reviewed first;
- visible output path under `.understudy/`.

Keep public examples synthetic or user-provided. Do not include customer names,
domains, private runbooks, raw prompts, raw completions, secrets, or internal
hosted-control details in public skill output.

## Intake

1. Identify the user's intent from the actual request, not from nearby files.
2. Ask at most one clarifying question if the route is ambiguous.
3. Prefer a local replay, dry-run, fixture, or status check before provider
   calls, uploads, or hosted jobs.
4. State which specialist skill you are using and why.

## Flow

Route by the smallest matching intent:

- New user, product tour, or "show me how this works": read
  [`../understudy-demo/SKILL.md`](../understudy-demo/SKILL.md).
- Existing prompts, traces, eval rows, reports, datasets, or model comparison:
  read [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).
- Improve measured quality, latency, cost, parsing, routing, or reliability:
  read [`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).
- SFT, preference data, RL trajectories, adapters, or hosted training handoff:
  read [`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).
- Multi-run research, hypotheses, budgets, experiment notes, or decision logs:
  read [`../understudy-lab/SKILL.md`](../understudy-lab/SKILL.md).
- Local OpenAI-compatible proxy, trace capture, or replay through a local
  endpoint: read
  [`../understudy-local-proxy/SKILL.md`](../understudy-local-proxy/SKILL.md).
- Provider key setup or local credential health: read
  [`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md).
- Model availability, runner compatibility, or local-vs-remote candidate
  choice: read
  [`../understudy-model-lookup/SKILL.md`](../understudy-model-lookup/SKILL.md).

If more than one route applies, use this order: demo, evaluate, optimize,
train, lab, local proxy, provider keys, model lookup. Switch only when the
evidence changes.

## Output Standard

End with:

- which specialist skill was used or should be used next;
- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command from the specialist skill when available.
