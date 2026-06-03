---
name: understudy-optimize
description: Use when improving a measured workload through prompt, routing, repair, candidate-search, or cost-quality changes.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Optimize

Use this skill when the developer asks to improve a measured workload, beat a
baseline, lower cost, repair failures, compare routes, or promote a candidate.

Do not use this skill when no baseline exists. Route first measurement to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md). Route
training, SFT, LoRA, preference-data, or hosted-training requests to
[`../understudy-train/SKILL.md`](../understudy-train/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work. Start with replay, dry-run,
schema repair, parser repair, prompt variants, renderer changes, context
trimming, and local routing checks.

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets unless the developer explicitly
approves that exact action in the current thread.

Treat configured provider keys as local machine state, not permission to spend.
Before live calls, hosted jobs, uploads, benchmark submission, or training,
require:

- named provider or hosted surface;
- estimated or capped budget;
- exact artifacts or data class being sent;
- reviewed dry-run or preview artifact;
- visible output path under `.understudy/`.

Never tune on heldout rows. Preserve validation and heldout boundaries in every
candidate card, score artifact, and recommendation.

## Evidence Ladder

Use [`../../docs/methodology-framework.md`](../../docs/methodology-framework.md)
as the public evidence ladder.

Do not promote a candidate from optimizer output alone. A promotion claim needs
a baseline comparison, split refs, failure taxonomy, cost and latency deltas,
fallback route, demotion trigger, and caveats.

## Intake

1. Inspect the current baseline report, candidate card, decision packet, eval
   artifact, or workload profile.
2. Confirm metrics, incumbent route, split boundaries, sample size, failure
   classes, cost, latency, and fallback route.
3. Identify the cheapest intervention class that matches observed failures.
4. Run the smallest no-spend status or dry-run command.
5. Summarize current evidence before proposing paid, hosted, or upload steps.

## Flow

1. Check local CLI health and optimization surfaces:

```sh
run_understudy --help
run_understudy optimize --help
```

2. Inspect existing local experiment or optimization state:

```sh
run_understudy optimize status --local
```

3. If no durable plan exists, create a local dry-run plan before running work:

```sh
run_understudy optimize plan --dry-run --local
```

4. Run cheap local interventions first:

```sh
run_understudy optimize run --dry-run --local
```

5. Read generated artifacts under:

```text
.understudy/optimize/
```

6. Promote narrowly. A candidate needs a repeatable command, split refs,
   failure taxonomy, baseline comparison, cost and latency deltas, fallback
   route, demotion trigger, and known limitations.

7. Treat failed screens as next-step inputs, not terminal conclusions.

## References

Load deeper material only when needed:

- [`reference.md`](reference.md) - detailed command matrix, artifact contract,
  and interpretation rules.
- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md)
  - baseline and comparison measurement.
- [`../understudy-value-reporting/SKILL.md`](../understudy-value-reporting/SKILL.md)
  - decision/value reporting from measured evidence.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- incumbent route, candidate route, metric delta, cost delta, and caveats;
- approval-gated next step, if any;
- one recommended command.
