"""DSPy-program lane tests. Skips when dspy is absent (optional install)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip("dspy")

import dspy  # noqa: E402
from dspy.utils import DummyLM  # noqa: E402

_SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "validate-and-optimize" / "scripts"
sys.path.insert(0, str(_SCRIPTS))

from dspy_program import (  # noqa: E402
    build_program,
    build_signature,
    examples_from_rows,
    parity_check,
)


def test_build_signature_and_program_structure():
    sig = build_signature(["question"], ["answer"])
    assert set(sig.model_fields) == {"question", "answer"}
    prog = build_program(["question"], ["answer"], module="predict")
    assert isinstance(prog, dspy.Predict)
    with pytest.raises(ValueError):
        build_signature([], ["answer"])
    with pytest.raises(ValueError):
        build_program(["q"], ["a"], module="react")  # react needs tools


def test_examples_from_rows_marks_inputs():
    rows = [{"question": "q1", "answer": "a1"}, {"question": "q2", "answer": "a2"}]
    examples = examples_from_rows(rows, ["question"])
    assert len(examples) == 2
    assert examples[0].inputs().toDict() == {"question": "q1"}


def _exact_match(example, pred, trace=None) -> float:
    return 1.0 if getattr(pred, "answer", None) == example["answer"] else 0.0


def test_parity_check_passes_when_program_matches_baseline():
    # DummyLM returns the correct answer for both holdout rows → program_score 1.0.
    dspy.configure(lm=DummyLM([{"answer": "a1"}, {"answer": "a2"}]))
    prog = build_program(["question"], ["answer"], module="predict")
    holdout = examples_from_rows(
        [{"question": "q1", "answer": "a1"}, {"question": "q2", "answer": "a2"}], ["question"]
    )
    res = parity_check(prog, holdout, _exact_match, baseline_score=0.9, input_keys=["question"])
    assert res.parity is True
    assert res.program_score == 1.0


def test_parity_check_fails_when_program_underperforms_baseline():
    # DummyLM returns wrong answers → program_score 0.0, well below baseline.
    dspy.configure(lm=DummyLM([{"answer": "WRONG"}, {"answer": "WRONG"}]))
    prog = build_program(["question"], ["answer"], module="predict")
    holdout = examples_from_rows(
        [{"question": "q1", "answer": "a1"}, {"question": "q2", "answer": "a2"}], ["question"]
    )
    res = parity_check(prog, holdout, _exact_match, baseline_score=0.9, input_keys=["question"])
    assert res.parity is False  # reconstruction diverges from production → gate blocks
    assert res.program_score == 0.0
