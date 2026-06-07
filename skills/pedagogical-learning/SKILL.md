---
name: pedagogical-learning
description: Use when a developer has privileged answers, execution feedback, verifier traces, or canonical solutions and wants a local model to learn from trajectories that are both correct and learnable, before moving to SFT, GRPO, or hosted RL.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Pedagogical Learning

Use this worker when privileged information should help **find teachable
trajectories**, not merely score rollouts after the fact. The goal is to turn a
weak local model's failures into local evidence about which trajectories are:

- correct under a verifier, answer key, state diff, or execution result;
- plausible for the current student model to imitate;
- free of shortcuts, hidden facts, answer-key references, and unsupported jumps.

This is a local evidence and data-selection skill. It may prepare SFT, GRPO, or
verifier-handoff artifacts, but it does not silently train weights or upload
data.

## Safety Gates

Default to local, synthetic, redacted, or benchmark-sandbox data. Do not upload
prompts, traces, completions, labels, datasets, repo paths, or private notes.

Get explicit approval before provider calls, hosted jobs, model downloads,
weight updates, adapter fusion, publishing artifacts, or running any command that
can mutate files outside `.understudy/`.

Do not claim "pedagogical RL worked" from prompt-only experiments. Prompt-only
smokes can prove headroom and scoring shape; they are not policy training. Label
local SFT as imitation, GRPO as on-policy reward optimization, and hosted RL as a
handoff.

Do not trust the same weak model as both generator and sole judge for
learnability. If token-level logprobs are unavailable, use deterministic
structure checks, an external verifier, or a stronger approved judge, and label
the score as a proxy.

## When To Use

Use this skill when all of these hold:

- there is privileged context `c`: gold answers, validator output, execution
  feedback, final-state diffs, oracle tool sets, canonical traces, or policy
  explanations;
- the local student model sees only task input `x` at deployment time;
- blind rollouts from the student have meaningful failure rate or high variance;
- successful trajectories must be learnable, not just correct by shortcut;
- the developer wants a rung before hosted RL or broad model climbing.

If the workload is still not understood, route to
[`../understand-workload/SKILL.md`](../understand-workload/SKILL.md). If there is
no resettable harness or metric, route to
[`../capture-evidence/SKILL.md`](../capture-evidence/SKILL.md). If prompt GEPA
is the cheapest live-rollout intervention, route to
[`../optimize-workload/SKILL.md`](../optimize-workload/SKILL.md).

## Flow

1. **Name the pedagogy contract.** Write down `x`, privileged context `c`,
   trajectory shape, deploy-time student input, verifier `R`, and what would make
   a step unsupported. Examples: answer-key-only jumps, hidden tool labels,
   unexplained final-state edits, brittle chain-of-thought shortcuts, or
   impossible recovery from a corrupted prefix.

2. **Prove local headroom first.** On a tiny train/dev slice, compare at least
   three local conditions:
   - blind student: `x` only;
   - shortcut teacher: `x + c`, allowed to use the answer key directly;
   - pedagogical teacher: `x + c`, but required to output steps derivable from
     `x` alone.

3. **Score correctness and learnability separately.** Correctness comes from the
   verifier, answer key, or final-state validator. Learnability should prefer
   teacher-forced student logprobs or surprise-gap scores when available. If not,
   use deterministic checks such as required step labels, no answer-key
   references, no hidden facts, no unfinished derivation, and answer plus
   derivation present. Same-model judge scores are advisory only.

4. **Look for the useful quadrant.** Keep trajectories that are both correct and
   learnable. Reject answer-key shortcuts even when correct. Reject verbose
   derivations that time out, omit the final answer, or require facts not visible
   to the deployed student.

5. **Pick the next rung.**
   - If a template or route makes the local model correct and learnable, feed it
     to `optimize-workload` or `recursive-language-model`; no weight update yet.
   - If correct-and-learnable trajectories can be generated reliably for a flat
     completion or single-output task, prepare a rejection-sampled SFT dataset
     for local MLX LoRA. This is the default first weight-update rung because it
     is simple, local, and easy to verify.
   - If the task is stateful — tools, documents, code, browser, API state,
     recursive subcalls, or long context — route to
     [`../rlm-pedagogical-training/SKILL.md`](../rlm-pedagogical-training/SKILL.md)
     so the environment and trajectories are represented before weight updates.
   - If a fast reward exists for generated completions, prepare a GRPO smoke with
     reward functions for correctness and learnability. Prefer single-output
     rewards first; multi-step rollout rewards are slower and should usually
     follow a rejection-SFT proof or a simpler learned advisor surface.
   - If the reward requires long stateful rollouts, route to
     `rlm-pedagogical-training` first. Route to `prepare-verifier-handoff` only
     when local RLM/distillation rungs stall.

6. **Record artifacts locally.** Use an ignored directory such as:

   ```text
   .understudy/pedagogical-learning/<run-id>/
     contract.json
     tasks.jsonl
     rollouts.jsonl
     scoring.json
     selected-trajectories.jsonl
     next-rung.md
   ```

## Local MLX Rungs

For Apple Silicon, prefer the smallest working local rung: prompt/template proof,
then rejection-sampled SFT, then GRPO only when reward calls are cheap. See
[`reference.md`](reference.md) for the local trainer boundary and adapter
evidence checklist.

## Output Standard

End with:

- the local model and runtime used;
- task count and split;
- blind, shortcut, and pedagogical scores for correctness and learnability;
- whether learnability was measured by logprobs, deterministic proxy, verifier,
  or judge;
- selected trajectory count;
- next rung: template/GEPA, RLM, rejection SFT, GRPO smoke, or verifier handoff;
- artifact path under `.understudy/`.
