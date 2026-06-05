---
name: understudy-decision-packet
description: Advanced/standalone formatting of existing evidence into a promote, hold, rerun, train, or publish note. For the gated MVP claim prefer `validate-and-optimize`, which emits the hash-bound claim packet. Use this only to write up a decision from evidence you already trust.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: true
---

# Understudy Decision Packet

Use this skill after evaluation or optimization when the developer needs a
stop/go decision, promotion recommendation, rerun plan, training handoff, or
publishable evidence boundary.

Do not use this skill to invent missing evidence. If the baseline, candidate,
sample size, split boundary, cost basis, or latency basis is missing, route back
to [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Decision packets must label result type, sample size, split boundary, baseline
route, candidate route, cost basis, latency basis, failure taxonomy, fallback
route, demotion trigger, and caveats.

## Flow

1. Inspect the Workload Card, Route Decision Packet, eval report, optimizer
   report, or value report.
2. Classify the evidence level using
   [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md).
3. Draft a packet from
   [`../../docs/decision-packet-template.md`](../../docs/decision-packet-template.md).
4. Choose exactly one decision: promote, hold, rerun, optimize, train, or
   publish.
5. If evidence is below heldout or live validation, mark promotion as a
   hypothesis and recommend the next local command.

## Output Standard

End with:

- decision and evidence level;
- baseline and candidate;
- artifact paths read or created;
- caveats and missing evidence;
- approval-gated next step, if any;
- one recommended command.
