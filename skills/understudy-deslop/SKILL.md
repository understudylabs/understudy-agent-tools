---
name: understudy-deslop
description: Rewrite Understudy reports, public notes, and result summaries into direct, evidence-grounded prose without private details.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: false
---

# Understudy Deslop

Use this skill when the developer asks to tighten, de-hype, polish, shorten,
or make an Understudy result report sound more direct and human.

Do not use this skill to change the underlying claim, add unsupported
traction, or soften material caveats. Route missing evidence to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) or
[`../understudy-value-reporting/SKILL.md`](../understudy-value-reporting/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not preserve private identifiers merely because they appear in the source
draft. Replace customer names, domains, private repo paths, raw prompts, raw
completions, trace rows, and secrets with public-safe descriptors or remove the
sentence.

## Intake

1. Read the source draft and identify the audience, claim, evidence, caveats,
   and requested output format.
2. Mark facts that need artifact support before rewriting them as assertions.
3. Preserve numbers, model names, dates, and result types when they are safe
   and load-bearing.
4. Ask for missing audience context only when the rewrite would otherwise
   change materially.

## Flow

1. Lead with the concrete result or decision.
2. Replace generic hype with measured evidence.
3. Use short sentences and active verbs.
4. Keep caveats attached to the claims they qualify.
5. Remove filler, invented urgency, vague superlatives, and internal process
   narration.
6. Preserve approval gates for uploads, live calls, training, benchmark
   submission, and provider spend.
7. Return the rewritten text first, then a short note on any claim that still
   needs evidence.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command or edit.
