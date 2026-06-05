---
name: understudy-tufte
description: Review charts, tables, and result visuals for truthful, compact, public-safe Understudy reporting.
metadata:
  understudy:
    mode: reporting
    safety: local-first
    cli_required: false
---

# Understudy Tufte

Use this skill when the developer asks to improve a chart, result visual,
metric table, executive graphic, or public report figure.

Do not use this skill to create unsupported interactive dashboards or to make
new measurement claims. Route measurement questions to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md) and value
claims to
[`../understudy-value-reporting/SKILL.md`](../understudy-value-reporting/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Do not include raw customer prompts, completions, trace rows, private repo
paths, or private labels in chart titles, labels, legends, annotations, or
example data.

## Intake

1. Inspect the chart, table, screenshot, or source data the developer provided.
2. Identify the intended audience, decision, measured unit, denominator, and
   comparison baseline from the artifact itself when possible.
3. Separate visual critique from data correctness. If the metric definition is
   unclear, mark the critique as conditional.
4. Prefer local files and screenshots. Do not upload visuals or data to hosted
   tools without explicit approval.

## Flow

1. Check whether the visual answers one decision question.
2. Remove non-data ink that does not aid comparison.
3. Keep labels close to the marks they explain.
4. Use small multiples or grouped comparisons when they reduce legend chasing.
5. Preserve uncertainty, sample size, denominator, and result type.
6. Flag misleading axes, truncated ranges, double axes, over-precise labels,
   inconsistent units, and claims without denominators.
7. Recommend the smallest edit that makes the result more truthful and easier
   to scan.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- approval-gated next step, if any;
- one recommended command or edit.
