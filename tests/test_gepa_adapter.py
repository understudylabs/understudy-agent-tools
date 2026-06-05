"""Adapter protocol test for the live-GEPA follow-up.

Skips when `gepa` is not installed (it is a detect-and-prompt dependency, not a
hard dep). Run locally with: `uv run --with 'gepa>=0.0.27,<0.1' pytest -q`.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip("gepa")

# The adapter lives in the skill-local scripts dir (not the top-level package).
_SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "validate-and-optimize" / "scripts"
sys.path.insert(0, str(_SCRIPTS))

from _adapter import UnderstudyGepaAdapter  # noqa: E402


# --- single-turn: infer returns a string, metric scores the string ----------

def _single_turn_infer(candidate: dict, example: dict) -> str:
    return f"{candidate['prompt']}::{example['inputs']['q']}"


def _single_turn_metric(example: dict, output: str) -> tuple[float, str]:
    want = example["target"]["a"]
    if want in output:
        return 1.0, "Correct."
    return 0.0, f"Expected '{want}' in output; got '{output[-20:]}'. Tighten the prompt."


def _single_turn_batch() -> list[dict]:
    return [
        {"inputs": {"q": "alpha"}, "target": {"a": "alpha"}},
        {"inputs": {"q": "beta"}, "target": {"a": "ZZZ"}},  # will fail
    ]


def test_single_turn_evaluate_and_reflect():
    adapter = UnderstudyGepaAdapter(infer=_single_turn_infer, metric=_single_turn_metric)
    eval_batch = adapter.evaluate(_single_turn_batch(), {"prompt": "SOLVE"}, capture_traces=True)
    assert eval_batch.scores == [1.0, 0.0]
    assert eval_batch.outputs[0].startswith("SOLVE::")
    reflective = adapter.make_reflective_dataset({"prompt": "SOLVE"}, eval_batch, ["prompt"])
    failing = [r for r in reflective["prompt"] if r["Score"] == 0.0][0]
    assert "Tighten the prompt" in failing["Feedback"]


def test_evaluate_without_traces_omits_trajectories():
    adapter = UnderstudyGepaAdapter(infer=_single_turn_infer, metric=_single_turn_metric)
    result = adapter.evaluate(_single_turn_batch(), {"prompt": "SOLVE"}, capture_traces=False)
    assert result.trajectories is None and len(result.scores) == 2


# --- multi-turn: infer returns a trajectory, metric scores the tool sequence --

def _multi_turn_infer(candidate: dict, example: dict) -> dict:
    # A multi-turn agent loop driven by the candidate's system prompt; returns a
    # trajectory (the tool-call sequence), not a single string.
    if "use search before answering" in candidate["prompt"].lower():
        tools = ["search", "answer"]
    else:
        tools = ["answer"]
    return {"tool_sequence": tools, "turns": len(tools)}


def _multi_turn_metric(example: dict, output: dict) -> tuple[float, str]:
    want = example["target"]["tool_sequence"]
    got = output["tool_sequence"]
    if got == want:
        return 1.0, "Correct tool sequence."
    return 0.0, (
        f"Tool-sequence mismatch: expected {want}, got {got}. "
        "Instruct the agent to search before answering."
    )


def test_multi_turn_trajectory_evaluate_and_reflect():
    adapter = UnderstudyGepaAdapter(infer=_multi_turn_infer, metric=_multi_turn_metric)
    batch = [{"inputs": {"q": "x"}, "target": {"tool_sequence": ["search", "answer"]}}]
    eval_batch = adapter.evaluate(batch, {"prompt": "answer directly"}, capture_traces=True)
    # The output is a trajectory, scored on the whole tool sequence.
    assert eval_batch.outputs[0]["tool_sequence"] == ["answer"]
    assert eval_batch.scores == [0.0]
    reflective = adapter.make_reflective_dataset({"prompt": "answer directly"}, eval_batch, ["prompt"])
    assert "search before answering" in reflective["prompt"][0]["Feedback"]


def test_multi_component_candidate_supported():
    # A multi-step pipeline: GEPA may update several components at once.
    adapter = UnderstudyGepaAdapter(
        infer=lambda cand, ex: f"{cand['planner']}|{cand['solver']}",
        metric=lambda ex, out: (1.0, "ok"),
    )
    cand = {"planner": "P", "solver": "S"}
    eval_batch = adapter.evaluate([{"inputs": {}}], cand, capture_traces=True)
    reflective = adapter.make_reflective_dataset(cand, eval_batch, ["planner", "solver"])
    assert set(reflective) == {"planner", "solver"}
