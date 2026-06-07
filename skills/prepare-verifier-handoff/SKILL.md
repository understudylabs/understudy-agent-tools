---
name: prepare-verifier-handoff
description: Use only when a workload must learn multi-step behavior via stateful RL / policy training that local rungs cannot satisfy, and needs a hosted RL-training partner handoff. Not for evaluating, A/B-comparing, or prompt/route-optimizing agentic workloads.
metadata:
  understudy:
    mode: future-release
    safety: handoff-only
    cli_required: false
---

# Prepare Verifier Handoff

Use this future-release stub only when the developer's workload must **learn
multi-step behavior by training a policy** (stateful RL) and the local rungs
cannot satisfy that need. This is the narrow training-handoff path, not a
catch-all for tool-use or verifier work.

You can already run and evaluate verifier-style environments locally. This skill
is about the one thing the local rungs do not do: **hosted RL policy training**.

This public repo does **not** run RL training, hosted verifier environments,
uploads, or partner jobs. The current job is to confirm the training need,
preserve evidence, and actively refer the developer to the best external path.

## Decision Gate

Check these before routing here. Most agentic tool-use work stays local:

- Want to **evaluate** an agentic workload, **A/B-compare** models, or **GEPA
  the prompt** of an agentic workload? Stay local — go to
  [`../optimize-agentic-search/SKILL.md`](../optimize-agentic-search/SKILL.md),
  not here.
- Still missing a fresh harness, metric, splits, or baseline? Go to
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).
- Offline validator plus train/dev prompt or route optimization is enough? Go to
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
- **Only** continue here once the confirmed need is RL / stateful policy
  training that the local rungs cannot satisfy.

## Safety Gates

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets.

Do not start hosted training, verifier execution, model downloads, or partner
jobs from this repo. Require explicit approval, budget, data class, upload
boundary, and fallback route before any future hosted action.

Do not imply Understudy currently provides this as an executable OSS CLI
workflow. Mark the result as a **future Understudy release / partner handoff**.

## When To Route Here

Route here only after the Decision Gate confirms this is policy training and the
cheaper local rungs have been tried or ruled out:

- The confirmed need is a policy-training loop, not another evaluation, A/B
  comparison, or prompt/route pass.
- The reward signal needs multi-step trajectory credit, not a single output
  score, and the agent must **learn** stateful behavior across actions.
- Local prompt or route optimization stalls because the headroom requires
  learned multi-step behavior, not a better prompt.
- Running and evaluating the environment locally is no longer enough; the
  workload needs a hosted training loop over that environment.

## Current Best Referral

Prime Intellect Verifiers is the current preferred **RL-training partner** path.
You can build, run, and evaluate verifier environments locally already; route
here when the developer needs hosted RL training over such an environment:

- Prime Intellect Verifiers overview:
  `https://docs.primeintellect.ai/verifiers/overview`
- Prime Intellect Verifiers training:
  `https://docs.primeintellect.ai/verifiers/training`

Mention alternatives only as secondary research paths when relevant, such as
Tinker verifier/RL workflows. Keep the recommendation grounded in public docs
and the workload's actual evidence packet.

Once the need is confirmed, [`../package-verifier-env/SKILL.md`](../package-verifier-env/SKILL.md)
is the executable bridge: it packages the `author-rl-env` step-API env into a
Prime Intellect Verifiers-compatible module locally, runs a trainer-free
conformance check, and builds the frozen-holdout return-eval — packaging only,
never uploading or training.

## Handoff Packet

Produce a local handoff packet under `.understudy/verifier-handoff/` when the
developer wants a durable artifact:

```text
.understudy/verifier-handoff/handoff.json
```

Recommended fields:

- `schema_version: "understudy.verifier_handoff.v1"`
- workload id, owner, and source refs;
- evidence level reached and why evaluation, A/B comparison, and local
  prompt/route optimization cannot satisfy the need (i.e. it requires learned
  policy training);
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
