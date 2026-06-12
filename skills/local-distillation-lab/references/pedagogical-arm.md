# Pedagogical arm — learning from privileged context

The deep playbook behind arm **P** in [`SKILL.md`](../SKILL.md)'s method
taxonomy (the surprisal-gated pedagogical variant), and the canonical home of
the shared pedagogy concepts: the `x`/`c` contract, correctness-vs-learnability
scoring, and the rung menu.
[`recursive-language-model` → pedagogical training](../../recursive-language-model/references/pedagogical-training.md)
applies the same concepts to stateful RLM policies and links back here rather
than restating them.

Use this playbook when privileged information should help **find teachable
trajectories**, not merely score rollouts after the fact. The goal is to turn a
weak local model's failures into local evidence about which trajectories are:

- correct under a verifier, answer key, state diff, or execution result;
- plausible for the current student model to imitate;
- free of shortcuts, hidden facts, answer-key references, and unsupported jumps.

This is local evidence and data selection. It may prepare SFT, GRPO, or
verifier-handoff artifacts, but it does not silently train weights or upload
data.

## Safety gates (pedagogy-specific)

Default to local, synthetic, redacted, or benchmark-sandbox data. Do not upload
prompts, traces, completions, labels, datasets, repo paths, or private notes.

Get explicit approval before provider calls, hosted jobs, model downloads,
weight updates, adapter fusion, publishing artifacts, or running any command
that can mutate files outside `.understudy/`.

Do not claim "pedagogical RL worked" from prompt-only experiments. Prompt-only
smokes can prove headroom and scoring shape; they are not policy training.
Label local SFT as imitation, GRPO as on-policy reward optimization, and hosted
RL as a handoff.

Do not trust the same weak model as both generator and sole judge for
learnability. If token-level logprobs are unavailable, use deterministic
structure checks, an external verifier, or a stronger approved judge, and label
the score as a proxy.

## When the arm applies

Use it when all of these hold:

- there is privileged context `c`: gold answers, validator output, execution
  feedback, final-state diffs, oracle tool sets, canonical traces, or policy
  explanations;
- the local student model sees only task input `x` at deployment time;
- blind rollouts from the student have meaningful failure rate or high variance;
- successful trajectories must be learnable, not just correct by shortcut;
- the developer wants a rung before hosted RL or broad model climbing.

If the workload is still not understood, route to
[`understand-workload`](../../understand-workload/SKILL.md). If there is no
resettable harness or metric, route to
[`capture-evidence`](../../capture-evidence/SKILL.md). If prompt GEPA is the
cheapest live-rollout intervention, route to
[`optimize-workload`](../../optimize-workload/SKILL.md).

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
     [`recursive-language-model` → pedagogical training](../../recursive-language-model/references/pedagogical-training.md)
     so the environment and trajectories are represented before weight updates.
   - If a fast reward exists for generated completions, prepare a GRPO smoke with
     reward functions for correctness and learnability. Prefer single-output
     rewards first; multi-step rollout rewards are slower and should usually
     follow a rejection-SFT proof or a simpler learned advisor surface.
   - If the reward requires long stateful rollouts, route to the RLM pedagogical
     training reference first. Route to
     [`prepare-verifier-handoff`](../../prepare-verifier-handoff/SKILL.md) only
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

## Local MLX rung order

For Apple Silicon, prefer the smallest working local rung:

- **Prompt/template proof**: serve the local model and generate blind,
  shortcut, and pedagogical rollouts. This is the fastest proof of headroom.
- **Rejection-sampled SFT**: keep only correct-and-learnable trajectories and
  run local `mlx_lm.lora` after approval. This is imitation, not RL. Evaluate
  the base model and adapter on the same sealed holdout before claiming the
  weights improved.
- **GRPO smoke**: use a reward function that returns correctness and
  learnability scores per completion. Treat third-party GRPO packages as
  prototype dependencies until pinned, audited, and smoked in an isolated env.
  Use this when the reward is cheap enough to run many times locally.
- **First-party rebuild**: if GRPO becomes core, prefer a narrow reward-runner
  adapter that consumes Understudy artifacts over vendor-locking a broad
  training CLI.

## Training boundary

The public repo may guide local training but should not hide training behind an
implicit command. Before any SFT, DPO, GRPO, adapter fusion, or model export,
ask for approval and name the base model, trainer, data path, expected runtime,
and rollback path.

For a real weight-update claim, record:

- base model path and content/hash identifier;
- trainer and version, for example `mlx_lm.lora`;
- train/dev/holdout split hashes;
- adapter path and whether it has been fused;
- before/after scores on the same heldout rows;
- regressions, format drift, latency change, and whether inference still uses
  only deploy-time input `x`.

## Choosing SFT vs GRPO

Use rejection-sampled SFT first when correct trajectories can be selected from
rollouts or teacher traces. It is the lowest-complexity proof that the local
weights can absorb the desired behavior.

Use GRPO when a reward is cheap, deterministic enough, and callable many times
per prompt. Single-output advisor, retrieval, classification, and formatting
surfaces are better first GRPO candidates than full multi-step tool rollouts.

For a full agentic rollout, prefer one of these before direct GRPO:

- rejection-SFT from passing trajectories;
- train a smaller advisor or router surface with a cheap reward;
- reduce the rollout into scored subdecisions;
- hand off only when local rungs stall and stateful policy learning is required.

## Output standard (pedagogical runs)

End a pedagogical run with:

- the local model and runtime used;
- task count and split;
- blind, shortcut, and pedagogical scores for correctness and learnability;
- whether learnability was measured by logprobs, deterministic proxy, verifier,
  or judge;
- selected trajectory count;
- next rung: template/GEPA, RLM, rejection SFT, GRPO smoke, or verifier handoff;
- artifact path under `.understudy/`.
