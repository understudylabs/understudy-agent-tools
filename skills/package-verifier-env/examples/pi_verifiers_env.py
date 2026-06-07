"""PI-Verifiers env package skeleton — maps an author-rl-env step-API MDP
(reset/step/score) onto the Prime Intellect Verifiers environment interface.

Packages LOCALLY only. Runs N rollouts against the seeded sim with NO trainer
and NO network. Does not upload or start hosted training.
Docs: https://docs.primeintellect.ai/verifiers/overview  (and /training)
"""
from __future__ import annotations
import json
import os
import random
from pathlib import Path

ROOT = Path(os.environ.get("UNDERSTUDY_WORKLOAD_ROOT", ".")).expanduser().resolve()
PKG = ROOT / ".understudy/verifier-env"

# TODO(dev): import your author-rl-env step-API env (reset/step/score MDP)
# from your_env import StepEnv          # reset()->obs ; step(action)->(obs,done,info) ; score(state)->float
# TODO(dev): import the SAME local scorer used by the pre-RL baseline (reward parity)
# from your_scorer import final_state_score

REWARD_KIND = os.environ.get("UNDERSTUDY_REWARD_KIND", "terminal")  # "terminal" | "shaped"


class VerifierEnv:
    """Adapter onto the verifiers framework's expected env interface.

    Maps StepEnv.reset/step/score -> reset()/step()/(terminal) reward. Keep the
    verifiers-facing method names aligned with the framework docs; this class is
    the single seam the partner's trainer drives.
    """

    def __init__(self, seed: int = 7, split: str = "train") -> None:
        assert split == "train", "RL-train pool excludes dev+holdout"  # safety gate
        self.seed = seed
        self.split = split
        # self.env = StepEnv(seed=seed, split=split)                   # TODO(dev)

    def reset(self):  # -> observation
        raise NotImplementedError("TODO(dev): return self.env.reset()")

    def step(self, action):  # -> (observation, reward, done, info)
        # obs, done, info = self.env.step(action)                      # TODO(dev)
        # reward = self._reward(done, info)
        # return obs, reward, done, info
        raise NotImplementedError("TODO(dev): drive self.env.step + self._reward")

    def _reward(self, done, info) -> float:
        # Pinned to the local scorer; terminal fractional final-state score by default.
        # if REWARD_KIND == "terminal":
        #     return final_state_score(self.env.state) if done else 0.0
        # else: additive, guarded shaping ON TOP of the same terminal score
        raise NotImplementedError("TODO(dev): pin to the baseline's local scorer")


def conformance_check(n_rollouts: int = 16, seed: int = 7, env_factory=None) -> dict:
    """Trainer-free: construct env, run N random/scripted rollouts, assert the
    round-trip + reward range, score the seeded oracle. Emits a JSON verdict.

    When env_factory is None this returns a `skeleton` verdict (the TODOs aren't
    wired yet) so the file runs end-to-end as a placeholder; once the dev wires
    VerifierEnv, pass env_factory=VerifierEnv to get a real pass/fail.
    """
    if env_factory is None:
        verdict = {"result_type": "verifier-env-conformance", "conformance": "skeleton",
                   "note": "wire VerifierEnv TODOs, then pass env_factory=VerifierEnv",
                   "n_rollouts": n_rollouts, "seed": seed, "reward_kind": REWARD_KIND}
        PKG.mkdir(parents=True, exist_ok=True)
        (PKG / "conformance.json").write_text(json.dumps(verdict, indent=2))
        return verdict

    rng = random.Random(seed)
    rewards, round_trip_ok = [], True
    try:
        for _ in range(n_rollouts):
            env = env_factory(seed=seed, split="train")
            obs = env.reset()
            done, steps = False, 0
            while not done and steps < 64:
                action = _random_action(obs, rng)
                obs, reward, done, _info = env.step(action)
                steps += 1
            rewards.append(reward)
    except Exception as exc:  # noqa: BLE001 — conformance must capture, not crash
        round_trip_ok = False
        rewards = rewards or [0.0]
        note = f"rollout raised: {type(exc).__name__}: {exc}"
    else:
        note = ""
    in_range = all(isinstance(r, (int, float)) and 0.0 <= r <= 1.0 for r in rewards)
    verdict = {
        "result_type": "verifier-env-conformance", "n_rollouts": n_rollouts, "seed": seed,
        "rewards_in_range": in_range, "round_trip_ok": round_trip_ok,
        "oracle_score": None,  # TODO(dev): expected oracle value
        "conformance": "pass" if (round_trip_ok and in_range) else "fail",
        "reward_kind": REWARD_KIND, "note": note,
    }
    PKG.mkdir(parents=True, exist_ok=True)
    (PKG / "conformance.json").write_text(json.dumps(verdict, indent=2))
    return verdict


def _random_action(obs, rng):
    tools = (obs or {}).get("tools", []) if isinstance(obs, dict) else []
    name = rng.choice(tools).get("name") if tools else "noop"
    return {"tool_calls": [{"name": name, "arguments": "{}"}]}


if __name__ == "__main__":
    print(json.dumps(conformance_check(), indent=2))
