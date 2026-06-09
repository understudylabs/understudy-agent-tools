# RLM Pedagogical Training Reference

This reference keeps setup and evaluation mechanics out of the main skill.

## Local Research Setup

Keep external research repos and generated artifacts out of the public package:

```sh
mkdir -p .understudy/research
git clone https://github.com/alexzhang13/rlm.git .understudy/research/rlm
```

The RLM repo's `training/` directory exposes `rlm.RLM` as a `verifiers`
environment and is designed to plug into Prime Intellect `prime-rl`. Treat that
repo as a research dependency until a local smoke proves the workflow belongs in
Understudy docs or golden-path fixtures.

Do not vendor RLM, Prime Intellect, or generated Python environments into this
repo. Public Understudy skills can point to setup commands and artifact shapes;
product code remains TypeScript-backed unless there is a deliberate architecture
change.

## Minimal Verifiers Shape

An RLM/verifiers environment needs:

- dataset rows with `prompt` or `root_prompt`;
- `info.context` containing the inspected corpus, tool catalog, state, or files;
- a correctness function over final answer, selected tools, retrieved evidence,
  or final state;
- metrics for iterations, REPL calls, sub-LM calls, and final-answer presence.

Good first tasks are small and verifiable:

- select the minimal tool set from a fixed catalog;
- retrieve the required evidence chunks;
- build a checklist from a fixed policy corpus;
- choose the next API operation in a simulated workflow;
- repair a final state to match a deterministic diff.

Avoid starting with broad final-answer generation when the evidence corpus,
rubric, or judge is incomplete.

## Pedagogical Reward Checklist

For a trajectory `tau`:

1. Score task success with `R(x,c,tau)`.
2. Teacher-force the same trajectory under the deploy student using `x` only.
3. Record token logprobs, mean surprise gap, max surprise gap, and spike penalty.
4. Prefer product rewards when partial credit exists:

   ```text
   r_ped = partial_credit(x,c,tau) * G_spike(tau | x)
   ```

5. Use additive reward only as an anti-stall scaffold for binary sparse rewards,
   and label it as such.

## Baseline Matrix

Run this before any training claim:

| condition | sees privileged context | stateful RLM | trains weights | purpose |
|---|---:|---:|---:|---|
| flat local | no | no | no | local floor |
| RLM local | no | yes | no | harness/decomposition value |
| privileged teacher | yes | yes | no | upper bound / data source |
| off-policy pedagogical SFT | train only | yes | yes | first local weight rung |
| on-policy repair | train only | yes | yes | state-coverage rung |
| pedagogical RL | train/reward only | yes | yes | true research target |

Only the `x`-only deploy conditions are eligible for product claims.

## Reading the training signal — background and references

Background for the "Reading the training signal" section of the skill.

**Why group reward-variance is the learning signal.** GRPO normalizes each
rollout's advantage *within its group* — subtract the group mean, divide by the
group std (DeepSeekMath, arXiv:2402.03300; DeepSeek-R1, arXiv:2501.12948). A
group whose rollouts all score the same has advantage ≈ 0 and contributes no
gradient. Near-zero variance under a sparse reward produces flat-then-jump
dynamics (grokking-like; cf. arXiv:2201.02177); reward shape governs what is
learnable (Ng, Harada & Russell, ICML 1999). Per-step train reward is noisy;
trust a moving average plus a small held-out eval every N steps (the ART·E
recipe evaluated every 30).

Measured on an internal synthetic workload, 2026-04-29 (a verifiers-shaped
reward moved GRPO 0.025→0.1 where action-level reward did not), and on an
ART·E Qwen-14B recreation, 2026-06-07 (`groups_trainable` held 4–11/12 from
step 1 → gradual climb exactly as the variance predicts). Public reproduction:
OpenPipe ART·E blog.

**Trainer/model fit details.** Renderer: prime-rl's `renderers` lib handles
multi-turn tokenization; a model with no per-model renderer falls back to
`DefaultRenderer` → token drift, flagged lossy / ~3x-cost for multi-turn.
Registry: the model must be in the trainer/inference registry (e.g. vLLM
`VLM_REGISTRY`). GRPO: merged support, not just SFT or an open PR. Field check
2026-06: prime-rl ships renderers for Qwen / GLM / MiniMax / DeepSeek / Kimi /
Nemotron / GPT-OSS but **not Gemma** (no merged Gemma-4 GRPO; `gemma4` absent
from registry; grad-norm blowup) → Gemma-4 multi-turn GRPO belongs on
Unsloth/TRL, while Nemotron-3 is first-class on prime-rl.

References:

- GRPO / within-group advantage normalization — Shao et al., *DeepSeekMath*,
  https://arxiv.org/abs/2402.03300 ; DeepSeek-AI, *DeepSeek-R1*,
  https://arxiv.org/abs/2501.12948
- Reward shape governs learnability — Ng, Harada & Russell, *Policy Invariance
  Under Reward Transformations* (ICML 1999), https://dl.acm.org/doi/10.5555/645528.657613
- Delayed/sudden-jump dynamics — Power et al., *Grokking*,
  https://arxiv.org/abs/2201.02177
- Prime Intellect `prime-rl` — https://github.com/PrimeIntellect-ai/prime-rl ;
  `renderers` — https://github.com/PrimeIntellect-ai/renderers ;
  vLLM model registry — https://github.com/vllm-project/vllm
- Public reproduction on this task: OpenPipe ART·E blog —
  https://openpipe.ai/blog/art-e-mail-agent

## Reconciliation Rules

Use these rules when multiple agents are running related experiments:

- RLM skill owns task/environment schema and verifier semantics.
- Local distillation skill owns mlx-vlm loading, local LoRA, and learning curves.
- Pedagogical-learning skill owns correct-and-learnable trajectory selection for
  flat or single-output tasks.
- Verifier handoff skill owns partner packets and approval gates.

If an external bench script proves a kernel, copy only the general method into a
skill or golden-path fixture after it passes a small smoke. Do not copy private paths,
private notes, raw prompts, or local-only failure logs into public docs.

## Negative Result Template

Negative results are valuable and should be recorded:

```text
Result: negative
Task: <subpolicy or full task>
Reason: <missing data / no verifier / local model capability / high spike / no state coverage>
Evidence: <baseline table or artifact path>
Next rung: <smaller subpolicy / RLM / same-family teacher / hosted handoff>
```

For hard legal or long-document work, a negative full-task result usually means
the next target is an RLM subpolicy such as evidence retrieval or checklist
construction, not immediate hosted RL.
