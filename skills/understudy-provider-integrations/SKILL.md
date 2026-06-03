---
name: understudy-provider-integrations
description: Use when mapping Understudy workloads to provider integrations, cookbooks, route decisions, training handoffs, or partner methodology.
metadata:
  understudy:
    mode: advisory
    safety: local-first
    cli_required: true
---

# Understudy Provider Integrations

Use this skill when the developer asks which provider to use, how Understudy
works with Fireworks, OpenRouter, Prime Intellect, Tinker, GCP, AWS, Lilac, or
local runners, or how provider cookbooks map into the public CLI roadmap.

Do not use this skill to run live provider calls. Route spend-ready key setup to
[`../understudy-provider-keys/SKILL.md`](../understudy-provider-keys/SKILL.md)
and measured comparisons to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Before recommending any live provider action, require a Workload Card, supplier
profile, pricing source, data boundary, budget/download/upload approval, and a
visible local output path.

## Flow

1. Start from a Workload Card or run workload discovery first.
2. Identify the provider use case: route discovery, serverless inference,
   frontier baseline, local runner, training handoff, verifier/RL environment,
   enterprise cloud route, or public reporting.
3. Read [`../../docs/provider-integration-cookbook.md`](../../docs/provider-integration-cookbook.md).
4. Check supplier profiles in
   [`../../docs/model-supplier-profiles.md`](../../docs/model-supplier-profiles.md).
5. Produce or update a Route Decision Packet before any live call, download,
   upload, or hosted job.

## Output Standard

End with:

- provider and use case;
- public docs/cookbook references used;
- required artifact before execution;
- spend/upload/download approval boundary;
- one recommended local command.
