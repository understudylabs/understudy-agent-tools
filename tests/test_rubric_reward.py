"""Rubric reward scorer — pure tests (no LM; the judge is injected)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "validate-and-optimize" / "scripts"
sys.path.insert(0, str(_SCRIPTS))

from rubric_reward import (  # noqa: E402
    Criterion,
    default_score_extractor,
    judge_human_agreement,
    load_criteria,
    score_pairwise,
    score_pointwise,
)


def test_load_criteria_validates():
    crit = load_criteria({"criteria": [{"id": "a", "description": "x", "weight": 2.0}]})
    assert crit == [Criterion(id="a", description="x", weight=2.0)]
    with pytest.raises(ValueError):
        load_criteria({"criteria": []})
    with pytest.raises(ValueError):
        load_criteria({"criteria": [{"id": "a", "description": ""}]})


def test_default_score_extractor():
    assert default_score_extractor("SCORE: 0.75 looks good") == 0.75
    assert default_score_extractor("verdict: PASS") == 1.0
    assert default_score_extractor("this is a FAIL") == 0.0
    assert default_score_extractor("no signal") == 0.0


def test_pointwise_weighted_score_and_feedback():
    criteria = [
        Criterion("faithful", "grounded", weight=2.0),
        Criterion("format", "schema ok", weight=1.0),
    ]
    # judge fails 'faithful' (weight 2), passes 'format' (weight 1) → 1/3.
    def judge(prompt: str) -> str:
        if "grounded" in prompt:
            return "SCORE: 0.0 fabricated a statistic"
        return "SCORE: 1.0 matches schema"

    res = score_pointwise(output="...", criteria=criteria, judge=judge)
    assert abs(res.score - (1.0 / 3.0)) < 1e-9
    assert "faithful" in res.feedback and "fabricated" in res.feedback
    assert "format" not in res.feedback  # only failing criteria surface


def test_pairwise_debias_cancels_position_bias():
    # A position-biased judge that always favors whichever response is "A".
    def biased_judge(prompt: str) -> str:
        return "SCORE: 1.0"  # always says A wins

    # r_ab = 1.0, r_ba = 1.0 → (1 - 1 + 2)/4 = 0.5 (tie), bias cancelled.
    win = score_pairwise(
        candidate_output="cand", incumbent_output="inc", rubric_text="r", judge=biased_judge
    )
    assert win == 0.5

    # A genuinely-better candidate: judge favors candidate regardless of slot.
    def fair_judge(prompt: str) -> str:
        a_is_candidate = prompt.index("cand") < prompt.index("inc")
        return "SCORE: 1.0" if a_is_candidate else "SCORE: 0.0"

    win2 = score_pairwise(
        candidate_output="cand", incumbent_output="inc", rubric_text="r", judge=fair_judge
    )
    # r_ab=1 (cand as A wins), r_ba=0 (cand as B loses) -> (1 - 0 + 1)/2 = 1.0
    assert win2 == 1.0


def test_judge_human_agreement_gate():
    assert judge_human_agreement(["a", "b", "c", "d"], ["a", "x", "c", "d"]) == 0.75
    with pytest.raises(ValueError):
        judge_human_agreement([], [])
