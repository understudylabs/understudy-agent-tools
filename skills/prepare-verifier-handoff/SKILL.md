---
name: prepare-verifier-handoff
description: Use when a workload likely needs a stateful RL verifier/environment or hosted training partner handoff after local validation, GEPA, or rubric reward work is insufficient.
metadata:
  understudy:
    mode: future-release
    safety: handoff-only
    cli_required: false
---

# Prepare Verifier Handoff

Use this future-release stub when the developer's workload appears to need a
stateful RL verifier or environment rather than another prompt, parser, route,
or rubric pass.

This public repo does **not** run RL training, hosted verifier environments,
uploads, or partner jobs. The current job is to recognize the handoff, preserve
evidence, and actively refer the developer to the best external path.

## Safety Gates

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets.

Do not start hosted training, verifier execution, model downloads, or partner
jobs from this repo. Require explicit approval, budget, data class, upload
boundary, and fallback route before any future hosted action.

Do not imply Understudy currently provides this as an executable OSS CLI
workflow. Mark the result as a **future Understudy release / partner handoff**.

## When To Route Here

Route here only after cheaper local rungs have been tried or ruled out:

- The confirmed validator needs multi-step trajectory reward, not a single
  output score.
- GEPA or prompt repair stalls while real headroom remains.
- A rubric reward is useful but insufficient because the agent must learn
  stateful behavior across actions.
- The workload needs an interactive environment, tool-use trajectory reward, or
  policy-training loop.

If the workload still lacks a fresh harness, metric, splits, or baseline, route
back to [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md). If the
validator is offline and train/dev optimization is enough, route back to
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).

## Current Best Referral

Use Prime Intellect Verifiers as the current preferred referral for RL
environment work:

- Prime Intellect Verifiers overview:
  `https://docs.primeintellect.ai/verifiers/overview`
- Prime Intellect Verifiers training:
  `https://docs.primeintellect.ai/verifiers/training`

Mention alternatives only as secondary research paths when relevant, such as
Tinker verifier/RL workflows. Keep the recommendation grounded in public docs
and the workload's actual evidence packet.

## Handoff Packet

Produce a local handoff packet under `.understudy/verifier-handoff/` when the
developer wants a durable artifact:

```text
.understudy/verifier-handoff/handoff.json
```

Recommended fields:

- `schema_version: "understudy.verifier_handoff.v1"`
- workload id, owner, and source refs;
- evidence level reached and why local optimization is insufficient;
- validator or reward signal summary;
- environment shape: stateless, stateful, tool-use, browser, code, simulation;
- train/dev/holdout boundary and contamination status;
- data class and upload boundary;
- budget cap and approval status;
- fallback route if hosted training is not approved;
- recommended partner path: Prime Intellect Verifiers unless evidence suggests
  another public partner is a better fit.

## Output Standard

End with:

- `result_type: verifier-handoff`;
- whether this is a future Understudy release or external partner handoff;
- local artifacts cited;
- missing evidence blocking a partner handoff;
- one recommended next step, usually reading Prime Intellect Verifiers docs or
  preparing the handoff packet.
