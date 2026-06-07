# Pedagogical Learning Reference

## Local MLX Rung Order

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

## Training Boundary

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
