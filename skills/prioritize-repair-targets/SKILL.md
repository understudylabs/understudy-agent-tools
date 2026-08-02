---
name: prioritize-repair-targets
description: Use when a developer asks which workloads to fix first across their LLM traffic, where the biggest savings opportunity is, or how to prioritize cheaper-model evaluations across multiple workloads.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Prioritize repair targets

Use this skill when the question spans multiple workloads. Stage local capture
files, provide a reviewed rate card, and run `understudy repair-targets rank`.
The command produces aggregate-only JSON and Markdown artifacts, with workload
aliases by default. It ranks where to spend evaluation effort; it does not
claim that a candidate model is accurate enough to ship.

## Safety Gates

This is a local, read-only ranking step. Do not upload captures, print raw
payloads, or treat the queue as evidence that a candidate model is safe to
ship. Require a reviewed, dated rate card and keep alias mappings under the
gitignored `.understudy/` directory. Capture files stay local and are never
uploaded by this workflow. Use the default anonymized output; keep any
`--no-anonymize` output under `.understudy/` and out of commits. Never invent
prices. Treat incumbent headroom as a heuristic prior and projected savings as
a planning band, not an invoice or quality measurement.

## Resolve CLI

Use the repository's built CLI (`npm run build`) or an installed
`understudy` binary. The ranking command is:

```sh
understudy repair-targets rank --captures <path> --rate-card <path>
```

## Workflow

1. Confirm the capture directory/file and the evaluation window.
2. Create and review a rate card:
   `understudy repair-targets rate-card-template --out .understudy/repair-targets/rate-card.json`
3. Fill prices from current vendor sources, including `source` and
   `checked_at`.
4. Rank:
   `understudy repair-targets rank --captures .understudy/captures --rate-card .understudy/repair-targets/rate-card.json`
5. Use the conservative queue to choose the first workload for
   `capture-evidence`, `optimize-workload`, or `compare-model-sweep`.

Read [`reference.md`](reference.md) for fingerprinting, scoring, and rate-card
details.
