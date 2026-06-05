---
name: understudy-blind-review
description: Use when qualitative outputs need stakeholder or judge review through anonymized pairwise candidate-vs-incumbent packets.
metadata:
  understudy:
    mode: evaluation
    safety: local-first
    cli_required: true
---

# Understudy Blind Review

Use this skill when quality is qualitative: search results, summaries,
extractions, rankings, recommendations, or tool-call outputs where stakeholders
need to compare incumbent and candidate outputs without seeing model labels.

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the shared `run_understudy` shell function.

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Blind review packets must hide candidate labels until after scoring. They must
not include customer names, private prompts, raw traces, or secrets in public
artifacts.

## Flow

1. Confirm the workload, incumbent output, candidate output, and review rubric.
2. Randomize output order per row and preserve ties and abstentions.
3. For high-stakes rows, use swapped-order checks before treating judge output
   as stable.
4. Include a small stakeholder calibration sample when human review is needed.
5. Report judge-vs-human agreement separately from candidate preference rate.

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
for the pairwise review method. Public background: MT-Bench / Chatbot Arena and
position-bias studies linked there.

## Output Standard

End with:

- review packet path or planned path;
- anonymization status;
- rubric and sample size;
- tie/abstention handling;
- approval-gated next step, if any;
- one recommended command.
