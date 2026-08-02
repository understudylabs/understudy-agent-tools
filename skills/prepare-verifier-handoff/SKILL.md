---
name: prepare-verifier-handoff
description: Use when a workload must learn multi-step behavior through hosted reinforcement-learning (RL) training that local optimization cannot deliver, and needs to become partner-ready. "My agent needs RL", "can we train this policy", "package my environment for a training partner", "is this workload ready for RL". Decides first, then authors the trainable environment, then packages it — never trains here.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Prepare Verifier Handoff

The single skill for "my workload needs hosted / stateful RL — get it
partner-ready." Use it only when the developer's workload must **learn
multi-step behavior by training a policy** (stateful RL) and the local rungs
cannot satisfy that need. This is the narrow training-handoff path, not a
catch-all for tool-use or verifier work.

You can already run and evaluate verifier-style environments locally. This skill
covers the one thing the local rungs do not do: getting a workload ready for
**hosted RL policy training**. The staged flow is:

```text
1. DECIDE   — confirm RL is actually the right rung (the gates below)
2. AUTHOR   — invert the sim env into a reset/step MDP
              → references/stage-1-author-env.md
3. PACKAGE  — wrap it as a Verifiers-compatible module + return-eval
              → references/stage-2-package-env.md
4. HAND OFF — packet + referral; the developer takes it to the partner
```

The decision comes **first**. Do not author or package an environment before
the gates confirm the need — an MDP wrapper built for a workload that a model
swap or prompt pass would have fixed is wasted work.

This public repo does **not** run RL training, hosted verifier environments,
uploads, or partner jobs. Stages 1–2 are local engineering; stage 3 ends in a
referral, and hosted training is the developer's partner action.

## Stage 0 — Decision Gate

Check these before doing anything else. Most agentic tool-use work stays local:

- Want to **evaluate** an agentic workload, **A/B-compare** models, or optimize
  the prompt of an agentic workload? Stay local — go to
  [`../optimize-agentic-workload/SKILL.md`](../optimize-agentic-workload/SKILL.md),
  not here.
- Still missing a fresh harness, metric, splits, or baseline? Go to
  [`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md).
- Offline validator plus train/dev prompt or route optimization is enough? Go to
  [`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).
- The missing piece is training an RLM policy from local privileged
  trajectories? Go to
  [`../recursive-language-model/references/pedagogical-training.md`](../recursive-language-model/references/pedagogical-training.md)
  first; this handoff is only for work that still needs external or hosted
  training. A local weight-update rung —
  [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md) —
  should be ruled out first when failure attribution says it could solve the
  residual; do not require a weak local experiment when the evidence already
  shows the missing capability needs hosted scale or a stronger trainer.
- **Before** continuing, confirm RL would not be wasted spend: (a) attribute
  the multi-turn rollouts and confirm the residual is **cross-turn reasoning**,
  not format or argument-value (cheaper rungs fix those); (b) the reward is
  **dense, not strict** — a binary/strict reward can be constant within a group,
  giving zero advantage and no gradient; and (c) the chosen model has a
  first-class multi-turn GRPO **trainer and renderer** (e.g. NVIDIA Nemotron-3
  does; Google Gemma-4 does not yet — no merged trainer, no multi-turn renderer).
  If any gate fails, fix it (or pick a supported model) before any RL handoff.
  Run [`../audit-verifier-reliability/SKILL.md`](../audit-verifier-reliability/SKILL.md)
  first; an environment whose reward has not passed that audit is not RL-ready.
  For (b), implement the rewardability check per
  [`references/rewardability.md`](references/rewardability.md) against the real
  scored-rollout artifact; for (c), use the model matrix in
  [`references/rl-readiness-matrix.md`](references/rl-readiness-matrix.md).
- **Only** continue once the confirmed need is RL / stateful policy training
  that the local rungs cannot satisfy. Record the confirmed need in
  `.understudy/verifier-handoff/handoff.json` (see Handoff Packet) — the later
  stages refuse to run without it.

## Safety Gates

Do not upload source files, prompts, traces, outputs, datasets, repo paths,
private notes, provider keys, or secrets.

Do not start hosted training, verifier execution, model downloads, or partner
jobs from this repo. Require explicit approval, budget, data class, upload
boundary, and fallback route before any future hosted action.

Recommend a budget envelope sized for the learning question, with expected
iterations, wall-clock, return-eval evidence, and the cheaper and accelerated
alternatives visible. Do not shrink the proposed run until it is unlikely to
answer the question merely to make the handoff look safer. Follow
[`../understudy/reference.md`](../understudy/reference.md) → Outcome-first spend
posture.

Stages 1–2 are local-only engineering: synthetic state only, no live side
effects, and the frozen dev/holdout rows never enter the RL train pool. Each
stage reference carries its own specific gates.

Do not imply Understudy currently provides hosted training as an executable OSS
CLI workflow. Mark the final result as a **partner handoff**.

## Stage 1 — Author the RL environment

Once the need is confirmed, invert the batch-scored simulated environment
(from
[`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md))
into a stateful step-API MDP an external trainer can drive: factor the agent
loop out, isolate per-rollout state, make `reset(task, seed)` deterministic,
pin the serializable obs/action contract, add the reward hook behind a
reward-hacking guard, pass the replay-conformance test, and exclude dev/holdout
from the RL train pool.

Full playbook, worked AutomationBench wiring, and the verified determinism
caveat: [`references/stage-1-author-env.md`](references/stage-1-author-env.md).

An `understudy.environment_proposal.v1` emitted by the JSONL drop flow is an
input to this stage, not proof that the stage is complete. Refuse handoff while
it is `needs_verifier`; revalidate hashes, oracle=1, sentinel rejection,
deterministic reset, nonconstant reward, no leakage/live effects, and parser
compatibility before packaging.

## Stage 2 — Package for the partner

With a conformant reset/step env, package it locally into a Prime Intellect
Verifiers-compatible module, run a trainer-free conformance check, pin the
reward to the local scorer, and build the frozen-holdout **return-eval** that
makes a partner-trained policy comparable to the pre-RL baseline. Packaging
only — never uploading or training.

Full playbook:
[`references/stage-2-package-env.md`](references/stage-2-package-env.md).

## Stage 3 — Hand off

Prime Intellect Verifiers is the current preferred **RL-training partner**
path. You can build, run, and evaluate verifier environments locally already;
the handoff is for hosted RL training over such an environment:

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

The packet's JSON Schema is checked in at
[`../../schemas/understudy.verifier_handoff.v1.schema.json`](../../schemas/understudy.verifier_handoff.v1.schema.json)
— validate against it before relying on a packet. Like `eval_result.v1` it is
additive-extensible: producers may add fields; consumers must ignore fields
they do not understand. Recommended fields:

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

Stage 2 updates this packet with the package location, conformance status, the
exact return-eval command, and the pinned reward definition.

## Output Standard

End with:

- `result_type: verifier-handoff` (or the stage output of the stage you
  stopped at — `rl-env-authored`, `verifier-env-package`, or `blocked`);
- which stage the workload is at (decide / author / package / hand off) and
  what gate, if any, blocked it;
- local artifacts cited (handoff packet, env path, conformance result,
  return-eval command);
- missing evidence blocking a partner handoff;
- one recommended next step.

## References

- [`references/stage-1-author-env.md`](references/stage-1-author-env.md) —
  invert the sim env into a reset/step MDP (obs/action contract recovery,
  determinism, replay conformance, holdout exclusion).
- [`references/stage-2-package-env.md`](references/stage-2-package-env.md) —
  package the env into a Verifiers-compatible module and build the
  frozen-holdout return-eval.
- [`references/rl-readiness-matrix.md`](references/rl-readiness-matrix.md) —
  which open models have a first-class multi-turn GRPO trainer + renderer (the
  decision-gate (c) lookup).
- [`references/rewardability.md`](references/rewardability.md) — an
  implementable principle (not a shipped script): the dense-vs-strict /
  constant-group / fail-closed checks the agent runs against the real
  scored-rollout artifact, with the failure modes it must handle.
- [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
  — builds the batch-scored sim env stage 1 inverts.
- [`../curate-trajectories/SKILL.md`](../curate-trajectories/SKILL.md) —
  supplies the decontaminated, holdout-free RL train pool.
