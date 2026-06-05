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


def _fake_infer(rendered_prompt: str, example: dict) -> str:
    # Echo the example's intended answer prefixed by the prompt marker so the
    # metric can score deterministically.
    return f"{rendered_prompt}::{example['inputs']['q']}"


def _fake_metric(example: dict, output: str) -> tuple[float, str]:
    want = example["target"]["a"]
    if want in output:
        return 1.0, "Correct."
    return 0.0, f"Expected '{want}' in output; got '{output[-20:]}'. Tighten the prompt."


def _batch() -> list[dict]:
    return [
        {"inputs": {"q": "alpha"}, "target": {"a": "alpha"}},
        {"inputs": {"q": "beta"}, "target": {"a": "ZZZ"}},  # will fail
    ]


def test_evaluate_returns_scores_and_outputs():
    adapter = UnderstudyGepaAdapter(infer=_fake_infer, metric=_fake_metric)
    result = adapter.evaluate(_batch(), {"prompt": "SOLVE"}, capture_traces=True)
    assert result.outputs[0].startswith("SOLVE::")
    assert result.scores == [1.0, 0.0]
    assert result.trajectories is not None and len(result.trajectories) == 2


def test_evaluate_without_traces_omits_trajectories():
    adapter = UnderstudyGepaAdapter(infer=_fake_infer, metric=_fake_metric)
    result = adapter.evaluate(_batch(), {"prompt": "SOLVE"}, capture_traces=False)
    assert result.trajectories is None
    assert len(result.scores) == 2


def test_reflective_dataset_surfaces_feedback_per_component():
    adapter = UnderstudyGepaAdapter(infer=_fake_infer, metric=_fake_metric)
    eval_batch = adapter.evaluate(_batch(), {"prompt": "SOLVE"}, capture_traces=True)
    reflective = adapter.make_reflective_dataset({"prompt": "SOLVE"}, eval_batch, ["prompt"])
    assert set(reflective) == {"prompt"}
    records = reflective["prompt"]
    assert len(records) == 2
    # The failing row carries the validator's diagnosis, not a bare score.
    failing = [r for r in records if r["Score"] == 0.0][0]
    assert "Tighten the prompt" in failing["Feedback"]
