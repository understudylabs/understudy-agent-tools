"""Replay-conformance test: prove the inverted env is faithful to the batch runner.

Loads a recorded trajectory JSON (the sim env's per-task output: messages,
steps, end_state, finish_reasons, score), extracts each assistant message's
`tool_calls` as the action sequence, replays them through a fresh
`RLEnv.reset()` + `step()` loop, and asserts the wrapper reproduces the recorded
`end_state` and `score`. A pass proves the step-API wrapper preserved the batch
runner's semantics; a fail localizes the divergence.

The __main__ block also enforces SKILL.md Flow step 7: it HARD-FAILS if any
replayed/training task_id belongs to the frozen seed-7 dev/holdout sets.

Usage:
    python replay_conformance.py <trajectory.json> [--splits splits.json]
"""
from __future__ import annotations
import argparse
import json
import sys
from typing import Any, Callable


def actions_from_trajectory(traj: dict) -> list[dict]:
    """obs/action contract recovery: each assistant message with tool_calls -> one action."""
    return [
        {"tool_calls": m["tool_calls"]}
        for m in traj.get("messages", [])
        if m.get("role") == "assistant" and m.get("tool_calls")
    ]


def replay(env, traj: dict, seed: int = 7) -> dict:
    task_id = str(traj.get("task_id", traj.get("id")))
    env.reset(task_id, seed)
    last_info: dict = {}
    total_reward = 0.0
    for action in actions_from_trajectory(traj):
        _obs, reward, done, last_info = env.step(action)
        total_reward += reward
        if done:
            break
    return {"end_state": last_info.get("end_state"), "score": total_reward}


def assert_conformance(env_factory: Callable[[], Any], traj_path: str, atol: float = 1e-6) -> dict:
    traj = json.load(open(traj_path))
    got = replay(env_factory(), traj)
    if got["end_state"] != traj.get("end_state"):
        raise AssertionError(f"end_state diverged: {got['end_state']} != {traj.get('end_state')}")
    if abs(got["score"] - float(traj.get("score", 0.0))) > atol:
        raise AssertionError(f"score diverged: {got['score']} != {traj.get('score')}")
    return got


def _frozen_eval_ids(splits_path: str) -> set[str]:
    s = json.load(open(splits_path))
    ids: set[str] = set()
    for split in ("dev", "holdout"):
        block = s.get(split, {})
        ids.update(str(x) for x in (block.get("row_ids", []) if isinstance(block, dict) else block))
    return ids


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trajectory")
    ap.add_argument("--splits", help="frozen splits.json; enforces holdout/dev exclusion")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    # The implementer supplies a real env_factory that wires the sim backend.
    # from rl_env_wrapper import RLEnv
    # env_factory = lambda: RLEnv(backend_factory=..., reward_fn=...)
    print("Provide an env_factory (see rl_env_wrapper.RLEnv) to run conformance.",
          file=sys.stderr)

    if args.splits:
        traj = json.load(open(args.trajectory))
        tid = str(traj.get("task_id", traj.get("id")))
        if tid in _frozen_eval_ids(args.splits):
            raise SystemExit(f"REFUSED: task {tid} is in the frozen dev/holdout set — "
                             "must not enter the RL train pool")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
