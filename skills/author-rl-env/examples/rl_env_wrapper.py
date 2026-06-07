"""Gym/verifiers-style step-API skeleton that INVERTS a batch sim runner.

This re-exposes the *existing* simulated backend (passed in via a factory, not
rebuilt) behind a step boundary an external RL trainer can drive:

    reset(task_id, seed) -> obs                        # fresh per-instance sim state
    step(action)         -> (obs', reward, done, info) # apply ONE tool call, mutate, return

Design invariants (see SKILL.md Flow):
  * Inversion of control — this env NEVER calls a model. The trainer owns the policy.
  * State isolation — all mutable state lives on the instance built in reset();
    no module-level globals, so concurrent rollouts can't cross-contaminate.
  * Determinism — reset is a pure function of (task_id, seed).
  * Serializable contract — obs/action JSON-serialize; recovered from recorded
    trajectory JSON (messages[].tool_calls).
  * Reward-hacking guard — shaping is additive, off by default, and may only
    reward verifiable progress toward the gold final state.

The implementer fills `backend_factory`, `reward_fn`, and (optionally)
`shaping_fn` by CALLING INTO the design-simulated-environment backend — do not
reimplement the sim here.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass
class Obs:
    """JSON-serializable observation: the running message list + tool catalog."""
    messages: list[dict]              # [{role, content, tool_calls?}]
    tools: list[dict]                 # OpenAI-style tool schemas

    def to_json(self) -> dict:
        return {"messages": self.messages, "tools": self.tools}


@dataclass
class Action:
    """JSON-serializable assistant action: one or more tool calls."""
    tool_calls: list[dict]            # [{id?, name, arguments}]

    @classmethod
    def from_json(cls, d: dict) -> "Action":
        return cls(tool_calls=d["tool_calls"])


def _assistant(action: Action) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": action.tool_calls}


class RLEnv:
    """Step-API MDP over an existing sim backend. One instance == one episode."""

    def __init__(
        self,
        backend_factory: Callable[[str, int], Any],   # (task_id, seed) -> fresh backend; NO globals
        reward_fn: Callable[[Any], float],            # backend -> terminal fractional score
        shaping_fn: Optional[Callable[[Any, Action], float]] = None,  # guarded, additive
    ) -> None:
        self._backend_factory = backend_factory
        self._reward_fn = reward_fn
        self._shaping_fn = shaping_fn
        self._b: Any = None           # per-instance state, created in reset()
        self._messages: list[dict] = []

    def reset(self, task_id: str, seed: int) -> dict:
        # Deterministic in (task_id, seed): the backend must route all RNG/clock/id
        # generation through `seed` so the same args reproduce byte-identical state.
        self._b = self._backend_factory(task_id, seed)
        self._messages = list(self._b.initial_messages())
        return Obs(self._messages, self._b.tools()).to_json()

    def step(self, action: dict):
        if self._b is None:
            raise RuntimeError("step() before reset()")
        a = Action.from_json(action)
        result_msgs = self._b.apply_tool_call(a)      # mutates THIS instance only
        self._messages.append(_assistant(a))
        self._messages.extend(result_msgs)
        done = bool(self._b.is_terminal())
        reward = self._reward_fn(self._b) if done else 0.0
        if self._shaping_fn is not None:              # additive, guarded
            reward += self._shaping_fn(self._b, a)
        obs = Obs(self._messages, self._b.tools()).to_json()
        info = {"end_state": self._b.end_state(), "steps": self._b.step_count()}
        return obs, reward, done, info


def progress_shaping(backend: Any, action: Action) -> float:
    """Example shaping under the reward-hacking guard.

    GUARD INVARIANT: the shaped optimum must coincide with the terminal optimum.
    Only award a small bonus when the action targets the GOLD app/endpoint AND
    the final gold score is still reachable. Never reward tool-call count,
    retries, or trajectory length — those can be maxed without raising `score`.
    """
    if backend.action_hits_gold_app(action) and backend.gold_still_reachable():
        return 0.05
    return 0.0


if __name__ == "__main__":
    # Smoke self-check with a trivial in-memory backend (no model, no network).
    class _ToyBackend:
        def __init__(self, task_id, seed):
            self.task_id, self.seed, self._steps, self._hit = task_id, seed, 0, False
        def initial_messages(self): return [{"role": "user", "content": f"task {self.task_id}"}]
        def tools(self): return [{"name": "api_search"}, {"name": "api_fetch"}]
        def apply_tool_call(self, a):
            self._steps += 1
            self._hit = any(tc.get("name") == "api_fetch" for tc in a.tool_calls)
            return [{"role": "tool", "content": "ok" if self._hit else "404"}]
        def is_terminal(self): return self._hit or self._steps >= 3
        def end_state(self): return {"done": self._hit}
        def step_count(self): return self._steps

    env = RLEnv(backend_factory=_ToyBackend, reward_fn=lambda b: 1.0 if b.end_state()["done"] else 0.0)
    env.reset("t1", seed=7)
    _, r1, d1, _ = env.step({"tool_calls": [{"name": "api_search", "arguments": {}}]})
    _, r2, d2, info = env.step({"tool_calls": [{"name": "api_fetch", "arguments": {}}]})
    assert d2 and r2 == 1.0, (r1, d1, r2, d2)
    print("ok: reset/step round-trip, terminal reward =", r2, "info =", info)
