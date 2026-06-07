---
name: rlm-pedagogical-training
description: Use when a developer wants to train or evaluate a Recursive Language Model policy with privileged context, verifiers, Prime Intellect prime-rl, or pedagogical RL. Turns a workload into an RLM/verifiers environment, measures on-policy state coverage and surprise concentration, and decides between local LoRA/distillation, true pedagogical RL, or hosted verifier handoff.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# RLM Pedagogical Training

Use this worker when the unit of learning is a **stateful policy**, not a flat
completion. The target is an RLM-style loop that learns how to inspect context,
choose tools, retrieve evidence, call sub-models, and stop with a final answer.

This is the bridge between:

- [`../recursive-language-model/SKILL.md`](../recursive-language-model/SKILL.md):
  build the decomposition harness;
- [`../pedagogical-learning/SKILL.md`](../pedagogical-learning/SKILL.md):
  use privileged context to find correct-and-learnable trajectories;
- [`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md):
  run local weight-update arms on Apple Silicon;
- [`../prepare-verifier-handoff/SKILL.md`](../prepare-verifier-handoff/SKILL.md):
  hand off only when local rungs cannot train the needed policy.

## When To Use

Use this skill when all of these are true:

- the workload has multi-step state: tools, documents, simulated state, code,
  browser, API calls, recursive sub-questions, or long context;
- there is privileged context `c`: gold paths, answer keys, execution feedback,
  final-state diffs, oracle tool/evidence labels, or validator traces;
- the deploy-time model must run from `x` only, without privileged context;
- a flat prompt, GEPA pass, or template is not enough, or the user explicitly
  wants RLM, verifiers, Prime Intellect `prime-rl`, or pedagogical RL.

If the workload is still unclear, route to
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md). If no
validator/splits/baseline exist, route to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md). If there is no
stateful policy, stay in
[`../pedagogical-learning/SKILL.md`](../pedagogical-learning/SKILL.md) or
[`../local-distillation-lab/SKILL.md`](../local-distillation-lab/SKILL.md).

## Safety Gates

Default to local, synthetic, redacted, or benchmark-sandbox data. Do not upload
prompts, traces, completions, labels, datasets, repo paths, or private notes.

Get explicit approval before model downloads, provider calls, hosted jobs,
Prime Intellect training, sandbox execution, adapter fusion, or publishing
artifacts.

Keep external research repos, generated environments, and private experiment
artifacts under ignored paths such as `.understudy/`. Do not vendor Python RL
training frameworks into this public repo without a deliberate architecture
change.

Do not claim a deploy win from privileged prompts, oracle tools, or train rows.
Only sealed holdout scores where the deployed student sees `x` only can support
a product claim.

## Core Claim

Do not claim "pedagogical RL worked" unless a policy was trained with a reward
that uses both task success and learnability. Local LoRA on teacher traces is
useful evidence, but it is **off-policy pedagogical SFT**, not true RL.

The stronger claim requires all three:

1. RLM trajectories from a stateful environment.
2. A reward `R(x,c,tau)` for task success.
3. A learnability or concentration term such as `G_spike(tau | x)` measured
   under the current student.

## Flow

1. **Name the RLM contract.** Write:
   - `x`: deploy-time task input;
   - `c`: privileged context available only for training/scoring;
   - `state`: what the RLM can inspect or mutate;
   - `actions`: inspect, retrieve, tool call, sub-LM call, summarize, answer;
   - `tau`: the recorded action trajectory;
   - `R`: deterministic verifier or reward;
   - `G`: learnability score, preferably surprise-gap / spike concentration.

2. **Choose the smallest learnable subpolicy.** For hard workloads, do not start
   with final work-product generation. Prefer a subpolicy that has labels and a
   deterministic scorer: tool selection, evidence retrieval, checklist
   construction, route choice, state repair, or citation selection.

3. **Build a local `verifiers` shape.** An RLM training row should map to:
   - prompt/root task in the dataset row;
   - `info.context` containing documents, state, tool catalog, or file payload;
   - a correctness function that scores the RLM final answer or final state;
   - trajectory metrics: iterations, REPL calls, sub-LM calls, final-answer
     presence, reward, and state deltas.

4. **Run baselines before training.**
   - Flat local model on the final output.
   - RLM local model with no privileged context.
   - Privileged teacher or same-family teacher, labeled as privileged.
   - Optional frontier teacher only after approval.

5. **Measure concentration.** For teacher or repaired trajectories, compute
   student forced logprobs and surprise gaps. Report mean `d_t`, max `d_t`, and
   spike penalty. This answers whether the teacher is giving learnable moves or
   unsupported jumps.

6. **Pick the training arm honestly.**
   - **Off-policy pedagogical SFT**: train on correct, low-spike teacher traces.
     This is the first local rung.
   - **On-policy repair / DAGGER-style**: sample student RLM trajectories, use
     privileged context to repair or label them, then train on those states.
   - **Pedagogical RL**: train a privileged self-teacher with reward
     `R(x,c,tau) * G_spike(tau | x)`, then assimilate into the student.
   - **Hosted verifier handoff**: only after local proof shows the policy needs
     stateful RL beyond the local machine.

7. **Seal holdout before promotion.** The deploy-time candidate must run from
   `x` only. Privileged context may score or train; it must not be passed at
   inference.

## Reconcile Parallel Research

When another agent is already running local Gemma/MLX kernels, do not duplicate
that work. Use this split:

- This skill owns the **environment contract**, RLM trajectory schema,
  verifier/reward shape, contamination boundary, and train/dev/holdout decision.
- `local-distillation-lab` owns the **Apple Silicon weight update**: mlx-vlm
  loader, forced-likelihood kernel, weighted LoRA, B/S/O/P arms, and learning
  curves.
- `prepare-verifier-handoff` owns the **external training packet** only after
  local rungs are insufficient and upload/budget boundaries are approved.

If parallel results conflict, trust sealed-holdout metrics over smoke results,
and trust deploy-time `x`-only scores over privileged or oracle-tool settings.

## Artifact Contract

Write local artifacts under:

```text
.understudy/rlm-pedagogical/<run-id>/
  contract.json
  dataset-card.json
  train.jsonl
  dev.jsonl
  holdout.jsonl
  baseline.json
  trajectories.jsonl
  concentration.json
  verifier-env.md
  training-plan.md
  claim.json
```

`claim.json` must say whether the result is:

- `rlm-baseline`;
- `off-policy-pedagogical-sft`;
- `on-policy-repair`;
- `pedagogical-rl-smoke`;
- `hosted-verifier-handoff`;
- `blocked`.

## Output Standard

End with:

- the chosen subpolicy and why it is learnable;
- dataset size and split hashes;
- local model/runtime;
- baseline table;
- concentration metrics;
- training arm selected and why;
- whether the result is a local proof, a negative result, or a verifier handoff;
- artifact path under `.understudy/`.

See [`reference.md`](reference.md) for setup commands and a Prime
Intellect/RLM bridge checklist.
