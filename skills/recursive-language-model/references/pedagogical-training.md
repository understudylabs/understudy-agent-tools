# Pedagogical training for RLM policies

The training path for [`SKILL.md`](../SKILL.md): use it when the unit of
learning is a **stateful policy**, not a flat completion. The target is an
RLM-style loop that learns how to inspect context, choose tools, retrieve
evidence, call sub-models, and stop with a final answer.

The shared pedagogy concepts — the `x`/`c` contract, correct-and-learnable
trajectory selection, the local MLX rung order, the training boundary, and the
SFT-vs-GRPO choice — live in
[`local-distillation-lab` → pedagogical arm](../../local-distillation-lab/references/pedagogical-arm.md).
This reference applies them to stateful trajectories and adds what is
RLM-specific: the verifiers environment shape, the baseline matrix, surprise
concentration, the training-arm choice, and how to read a live training run.

**Not for** environment mechanics or partner packaging: this reference owns
the learnability decision and the training-arm choice;
[`prepare-verifier-handoff`](../../prepare-verifier-handoff/SKILL.md) owns the
rest — building the `reset`/`step` environment once RL is the chosen arm
([`references/stage-1-author-env.md`](../../prepare-verifier-handoff/references/stage-1-author-env.md))
and packaging that env for a partner
([`references/stage-2-package-env.md`](../../prepare-verifier-handoff/references/stage-2-package-env.md)).

This is the bridge between:

- [`recursive-language-model`](../SKILL.md): build the decomposition harness;
- [`local-distillation-lab`](../../local-distillation-lab/SKILL.md): run local
  weight-update arms on Apple Silicon (its pedagogical arm owns
  correct-and-learnable selection for flat tasks);
- [`prepare-verifier-handoff`](../../prepare-verifier-handoff/SKILL.md): hand
  off only when local rungs cannot train the needed policy.

## When this applies

Use it when all of these are true:

- the workload has multi-step state: tools, documents, simulated state, code,
  browser, API calls, recursive sub-questions, or long context;
- there is privileged context `c`: gold paths, answer keys, execution feedback,
  final-state diffs, oracle tool/evidence labels, or validator traces;
- the deploy-time model must run from `x` only, without privileged context;
- a flat prompt, GEPA pass, or template is not enough, or the user explicitly
  wants RLM, verifiers, Prime Intellect `prime-rl`, or pedagogical RL.

If the workload is still unclear, route to
[`understand-workload`](../../understand-workload/SKILL.md). If no
validator/splits/baseline exist, route to
[`capture-evidence`](../../capture-evidence/SKILL.md). If there is no stateful
policy, stay in the
[pedagogical arm](../../local-distillation-lab/references/pedagogical-arm.md)
or [`local-distillation-lab`](../../local-distillation-lab/SKILL.md).

## Safety gates (training-specific)

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

## Core claim

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

## Reading the training signal

Read the signal before and during a GRPO / prime-rl run — do not just wait.

- **Group reward-variance is the learning signal.** GRPO normalizes each
  rollout's advantage within its group, so a group whose rollouts all score the
  same contributes no gradient. Check `groups_trainable` / per-group reward std
  over the first ~5 steps before forecasting an ETA: healthy variance from
  step 1 predicts a gradual, noisy climb with plateaus; near-zero variance
  (most groups all-fail or all-pass) predicts flat-until-a-lucky-success — fix
  the reward shape (denser / shaped signal) rather than waiting it out.
- **Read smoothed reward + a periodic held-out mini-eval, not per-step
  reward.** Timeline heuristic when variance is healthy: first drift
  ~step 30–50, clear trend ~step 100, gains across epochs.
- **When results conflict, trust sealed-holdout metrics over smoke results.**
  A quick smoke run never overrides a measured holdout eval.
- **Trainer/model fit check (before picking prime-rl vs Unsloth/TRL).** A model
  *loading* is not support. For multi-turn tool-use RL, confirm the trainer
  has, for that model: a multi-turn **renderer**, the model in the
  trainer/inference **registry**, and **merged GRPO** support — or switch
  trainers.

- High variance from step 1 (most groups mixed success/failure; prime-rl/ART
  `groups_trainable` healthy) → expect a **gradual, noisy climb** with plateaus.
- Near-zero variance (sparse reward — most groups all-fail or all-pass) → expect
  **flat until a lucky success** (grokking-like; cf. arXiv:2201.02177). Fix the
  reward shape (denser / shaped signal) rather than waiting it out — reward shape
  governs what is learnable (Ng, Harada & Russell, ICML 1999).

Check `groups_trainable` / per-group reward std over the first ~5 steps to set
expectations before forecasting an ETA.

**Read smoothed reward + a periodic held-out mini-eval, not per-step reward.**
Per-step train reward is noisy; trust a moving average plus a small held-out eval
every N steps (the ART·E recipe evaluated every 30). Timeline heuristic when
variance is healthy: first drift ~step 30–50, clear trend ~step 100, gains across
epochs.

Measured on an internal synthetic workload, 2026-04-29 (a verifiers-shaped
reward moved GRPO 0.025→0.1 where action-level reward did not), and on an ART·E
Qwen-14B recreation, 2026-06-07 (`groups_trainable` held 4–11/12 from step 1 →
gradual climb exactly as the variance predicts). Public reproduction: OpenPipe
ART·E blog.

**Trainer/model fit check (before picking prime-rl vs Unsloth/TRL).** A model
*loading* is not support. For multi-turn tool-use RL on a specific model, confirm
the trainer has, for that model: (1) a **renderer** for correct multi-turn
tokenization — prime-rl's `renderers` lib; no per-model renderer falls back to
`DefaultRenderer` → token drift, flagged lossy / ~3x-cost for multi-turn; (2) the
model in the trainer/inference **registry** (e.g. vLLM `VLM_REGISTRY`); (3)
**merged GRPO** support, not just SFT or an open PR. Field check 2026-06: prime-rl
ships renderers for Qwen / GLM / MiniMax / DeepSeek / Kimi / Nemotron / GPT-OSS but
**not Gemma** (no merged Gemma-4 GRPO; `gemma4` absent from registry; grad-norm
blowup) → Gemma-4 multi-turn GRPO belongs on Unsloth/TRL, while Nemotron-3 is
first-class on prime-rl. Match the model to the trainer that has all three, or
switch trainers. The canonical support table is
[`prepare-verifier-handoff` → rl-readiness-matrix](../../prepare-verifier-handoff/references/rl-readiness-matrix.md);
when a family's status changes, update both places together.

### References for this section

Original papers (theory):

- GRPO / within-group advantage normalization — Shao et al., *DeepSeekMath*,
  https://arxiv.org/abs/2402.03300 ; DeepSeek-AI, *DeepSeek-R1*,
  https://arxiv.org/abs/2501.12948
- Reward shape governs learnability — Ng, Harada & Russell, *Policy Invariance
  Under Reward Transformations* (ICML 1999), https://dl.acm.org/doi/10.5555/645528.657613
- Delayed/sudden-jump dynamics — Power et al., *Grokking*,
  https://arxiv.org/abs/2201.02177

Source projects (engineering facts — renderer/registry/GRPO support, env API):

- Prime Intellect `prime-rl` — https://github.com/PrimeIntellect-ai/prime-rl ;
  `renderers` — https://github.com/PrimeIntellect-ai/renderers ;
  vLLM model registry — https://github.com/vllm-project/vllm
- Public reproduction on this task: OpenPipe ART·E blog —
  https://openpipe.ai/blog/art-e-mail-agent

Measured on an internal synthetic workload, 2026-04-29, and on an ART·E
Qwen-14B recreation, 2026-06-07.

## Local research setup

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

## Minimal verifiers shape

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

## Pedagogical reward checklist

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

## Baseline matrix

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

## Cold-start data: harvest from a strong root, not weak failures

The cold-start SFT corpus should be *successful* trajectories from a capable model, not the
weak student's own failed rollouts (you would be teaching it to fail). The
**big-orchestrator / small-runner split** (see the skill's "orchestrator and runner need not
be the same model") is the natural generator: run the capable model as the orchestrator over
the task and collect its trajectories, then filter twice before they enter the SFT pool —

- **score gate**: keep only trajectories that pass the environment validator;
- **process gate**: of those, keep only the ones with clean process metrics (well-grounded,
  low replan-overlap, accurate sub-summaries) — a right-answer-by-luck trajectory with a
  messy process teaches the wrong decomposition.

SFT the small model on that filtered corpus to install the decomposition behavior, then RL
with the process metrics as the per-step reward (grounding / compaction / correct summaries),
not just the sparse final score. Route the filtered pool through
[`../../curate-trajectories/SKILL.md`](../../curate-trajectories/SKILL.md) so no frozen
dev/holdout rows leak into the train/RL pool.

## Ownership boundaries

When multiple agents run related experiments, keep the ownership split:

- this reference owns the **learnability decision**: RLM trajectory schema,
  verifier/reward shape, surprise concentration, contamination boundary, and
  the arm choice (pedagogical SFT vs on-policy repair vs RL vs handoff);
- [`prepare-verifier-handoff` stage 1](../../prepare-verifier-handoff/references/stage-1-author-env.md)
  owns the **environment mechanics** once RL is the chosen arm (reset/step
  inversion, state isolation, deterministic reset, replay-conformance), and
  [stage 2](../../prepare-verifier-handoff/references/stage-2-package-env.md)
  owns **packaging** plus the frozen-holdout return-eval;
- [`local-distillation-lab`](../../local-distillation-lab/SKILL.md) owns the
  **Apple Silicon weight update** (mlx-vlm loader, forced-likelihood kernel,
  weighted LoRA, B/S/O/P arms, learning curves), and its
  [pedagogical arm](../../local-distillation-lab/references/pedagogical-arm.md)
  owns correct-and-learnable selection for flat/single-output tasks;
- [`prepare-verifier-handoff`](../../prepare-verifier-handoff/SKILL.md) owns the
  **external training packet** only after local rungs are insufficient and
  upload/budget boundaries are approved.

If parallel results conflict, trust sealed-holdout metrics over smoke results,
and trust deploy-time `x`-only scores over privileged or oracle-tool settings.
If an external bench script proves a kernel, copy only the general method into
a skill or golden-path fixture after it passes a small smoke. Do not copy
private paths, private notes, raw prompts, or local-only failure logs into
public docs.

## Artifact contract

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

## Negative result template

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

## Output standard (training runs)

End a training run with:

- the chosen subpolicy and why it is learnable;
- dataset size and split hashes;
- local model/runtime;
- baseline table;
- concentration metrics;
- training arm selected and why;
- whether the result is a local proof, a negative result, or a verifier handoff;
- artifact path under `.understudy/`.
