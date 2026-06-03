---
name: understudy-train
description: Use when preparing local training handoffs for SFT, preference data, RL trajectories, LoRA adapters, or hosted jobs.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: true
---

# Understudy Train

Use this skill when the developer asks about fine-tuning, SFT, adapters,
preference data, RL trajectories, LoRA artifacts, local training preparation,
or hosted training jobs.

Do not use this skill for first-pass model comparison. Route evaluation to
[`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md).
For post-baseline prompt, routing, or repair improvements, route to
[`../understudy-optimize/SKILL.md`](../understudy-optimize/SKILL.md).

## Resolve CLI

Open and read [`../_resources/cli-bootstrap.md`](../_resources/cli-bootstrap.md),
then define the `run_understudy` shell function from that shared resource.

If `run_understudy` returns 127, activate
[`../understudy-bootstrap/SKILL.md`](../understudy-bootstrap/SKILL.md).

## Safety Gates

Default to local-only, no-upload, no-spend work. Training starts as a local
handoff: data audit, export preview, split validation, provenance check, and
artifact hashing.

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

Do not train on validation or heldout test rows. Do not start hosted training,
upload datasets, or publish adapters without exact approval in the current
thread.

## Intake

1. Inspect the measured baseline, failure taxonomy, candidate-card evidence, or
   evaluation report that justifies training.
2. Confirm training objective: SFT behavior repair, argument normalization,
   preference tuning, reward modeling, adapter export, or hosted job handoff.
3. Verify source rows, labels, split IDs, provenance, license constraints, and
   sanitization status.
4. Run the smallest no-spend status, export preview, or validation command.
5. Summarize current state before proposing paid, hosted, or upload steps.

## Flow

1. Check local CLI health and training surfaces:

```sh
run_understudy --help
run_understudy train --help
```

2. Inspect local training readiness:

```sh
run_understudy train status --local
```

3. Preview the export before writing or uploading any training data:

```sh
run_understudy train export --dry-run --local
```

4. Validate split integrity and provenance:

```sh
run_understudy train validate --dry-run --local
```

5. Read generated artifacts under:

```text
.understudy/train/
```

6. Hash local data and adapter artifacts before promotion. Report hashes and
   exact paths instead of copying payload contents into chat.

7. Treat hosted training as an approval-gated next step, not a default action.

## References

- [`reference.md`](reference.md) - detailed command matrix, artifact contract,
  and interpretation rules.
- [`../understudy-evaluate/SKILL.md`](../understudy-evaluate/SKILL.md)
  - baseline evidence and split-aware measurement.

## Output Standard

End with:

- what was inspected or run;
- artifact paths created or read;
- result type: dry-run, replay, fake-provider, validation, heldout, or live;
- split boundary, provenance status, artifact hashes, and caveats;
- approval-gated next step, if any;
- one recommended command.
