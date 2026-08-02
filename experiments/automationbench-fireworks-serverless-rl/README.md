# AutomationBench Fireworks Serverless RL

This experiment uses the same Tinker-compatible environment, renderer,
rollout, and `forward_backward`/`optim_step` seams for Fireworks serverless and
the direct Tinker lane.

## Safety gates

The `gate` command must pass before any model call:

```sh
/home/ubuntu/fw-venv/bin/python \
  experiments/automationbench-fireworks-serverless-rl/runner.py gate
```

It starts the compiled local HTTP environment service, replays all 48
train-only oracle trajectories through that HTTP path, runs the sentinel
through the same path, and checks fixture/split hashes. It never reads
holdout tasks.

## Base evaluation

The exact tokenizer and renderer pairings are:

```text
accounts/fireworks/models/qwen3p5-9b -> Qwen/Qwen3.5-9B / qwen3_5_disable_thinking
accounts/fireworks/models/qwen3p6-27b -> Qwen/Qwen3.6-27B / qwen3_5_disable_thinking
```

Run the written cost preflight first:

```sh
/home/ubuntu/fw-venv/bin/python \
  experiments/automationbench-fireworks-serverless-rl/runner.py preflight --cap 10
```

Then run train/dev evaluations with separate processes to keep both serverless
clients warm within each phase. Holdout is intentionally unavailable to this
CLI.

## RL update seam

`train_step()` accepts any backend implementing the small `Backend` protocol.
`ServerlessBackend` uses `FiretitanServiceClient` at the serverless URL;
`TinkerBackend` uses `tinker.ServiceClient`. `_build_datums()` preserves
episode-level GRPO advantages across every assistant turn and uses the
shifted next-token layout required by the importance-sampling loss. Groups
with no reward spread and sequences with mismatched token/logprob lengths are
dropped.

No training call is made by the milestone-1 commands.
