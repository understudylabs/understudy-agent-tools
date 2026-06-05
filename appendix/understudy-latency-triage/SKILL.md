---
name: understudy-latency-triage
description: Use when an AI workload is slow and the developer needs to separate inference, context, routing, retry, streaming, and app latency.
metadata:
  understudy:
    mode: diagnostic
    safety: local-first
    cli_required: true
---

# Understudy Latency Triage

Use this skill when the developer says an AI workflow is slow, latency-sensitive,
timeout-prone, or blocked by provider/model speed.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

## Flow

1. Identify the latency target and observed p50/p95/p99 when available.
2. Separate app latency from model latency: request construction, retrieval,
   tool calls, provider queueing, time-to-first-token, decode, retries,
   fallbacks, parsing, and post-processing.
3. Check context size before blaming model quality or provider speed.
4. Compare route classes: local runner, existing provider key, hosted
   open-weight, frontier API, or Understudy inference.
5. Recommend the smallest measurement that can change the routing decision.

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
for context triage and route-decision handoff.

## Output Standard

End with:

- latency target and observed bottleneck;
- evidence level and artifact paths;
- candidate route classes;
- approval-gated next step, if any;
- one recommended command.
