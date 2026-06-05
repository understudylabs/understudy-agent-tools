#!/usr/bin/env python3
"""Rubric-based reward scorer.

Turns a human-confirmed rubric + an LLM judge into `(score, feedback)` — a richer
validator kind for the optimize loop, and the **OSS half of the verifier rung**:
the rubric + judgment is portable and valuable on its own (it immediately makes
GEPA's metric graded instead of pass/fail); the RL *training* over the reward
stays hosted (full package), not here.

The judge is **injected** (`judge(prompt) -> verdict_text`) so this is
provider-agnostic and unit-testable without an LM. Pairwise mode cancels position
bias by judging both orderings and averaging — the same swapped two-pass idea as
the internal pairwise judge (here `(r_ab - r_ba + 1) / 2` for [0,1] judge scores;
the internal one uses `÷4` for a [-1,1] scale).

A rubric reward returns the same `(score, feedback)` shape the GEPA adapter's
`metric` expects, so a confirmed rubric is a drop-in metric for optimization.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

JudgeFn = Callable[[str], str]
# Extract a [0,1] score from a judge verdict. Default looks for SCORE: <n>.
ScoreExtractor = Callable[[str], float]


@dataclass(frozen=True)
class Criterion:
    id: str
    description: str
    weight: float = 1.0


def load_criteria(rubric: dict[str, Any]) -> list[Criterion]:
    raw = rubric.get("criteria")
    if not isinstance(raw, list) or not raw:
        raise ValueError("rubric must have a non-empty 'criteria' list")
    out: list[Criterion] = []
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            raise ValueError(f"criterion {i} must be an object")
        cid = str(item.get("id") or f"criterion_{i}")
        desc = str(item.get("description") or "").strip()
        if not desc:
            raise ValueError(f"criterion {cid} needs a description")
        weight = float(item.get("weight", 1.0))
        out.append(Criterion(id=cid, description=desc, weight=weight))
    return out


def default_score_extractor(verdict: str) -> float:
    """Parse `SCORE: 0.7` (0..1) or fall back to PASS/FAIL → 1.0/0.0."""
    m = re.search(r"score\s*[:=]\s*([01](?:\.\d+)?)", verdict, re.IGNORECASE)
    if m:
        return max(0.0, min(1.0, float(m.group(1))))
    if re.search(r"\bpass\b", verdict, re.IGNORECASE):
        return 1.0
    if re.search(r"\bfail\b", verdict, re.IGNORECASE):
        return 0.0
    return 0.0


@dataclass
class RubricResult:
    score: float
    feedback: str
    per_criterion: list[dict[str, Any]]


def score_pointwise(
    *,
    output: Any,
    criteria: list[Criterion],
    judge: JudgeFn,
    extract: ScoreExtractor = default_score_extractor,
    context: str = "",
) -> RubricResult:
    """Judge `output` against each criterion; weighted-mean score + feedback.

    Feedback is the rationale of the criteria that scored below 1.0 — the
    diagnosis GEPA reflects on, not a bare number.
    """
    rows: list[dict[str, Any]] = []
    weighted_sum = 0.0
    total_weight = 0.0
    for c in criteria:
        prompt = (
            f"{context}\nCriterion ({c.id}): {c.description}\n\n"
            f"Output under review:\n{output}\n\n"
            "Reply with `SCORE: <0..1>` then one sentence of rationale."
        )
        verdict = judge(prompt)
        s = extract(verdict)
        rationale = verdict.strip()
        rows.append({"id": c.id, "score": s, "weight": c.weight, "rationale": rationale})
        weighted_sum += s * c.weight
        total_weight += c.weight
    score = (weighted_sum / total_weight) if total_weight else 0.0
    failing = [r for r in rows if r["score"] < 1.0]
    if failing:
        feedback = "Rubric gaps:\n" + "\n".join(
            f"- [{r['id']} {r['score']:.2f}] {r['rationale']}" for r in failing
        )
    else:
        feedback = "All rubric criteria satisfied."
    return RubricResult(score=score, feedback=feedback, per_criterion=rows)


def score_pairwise(
    *,
    candidate_output: Any,
    incumbent_output: Any,
    rubric_text: str,
    judge: JudgeFn,
    extract: ScoreExtractor = default_score_extractor,
) -> float:
    """Swapped two-pass win score in [0,1]; 0.5 = tie. Cancels position bias.

    Both passes ask "how much does A beat B" on a [0,1] scale. With the candidate
    as A then as B, the debiased candidate-win is `(r_ab + (1 - r_ba)) / 2`,
    i.e. `(r_ab - r_ba + 1) / 2`. A symmetric (position-only) bias cancels.
    """

    def _prompt(a: Any, b: Any) -> str:
        return (
            f"Rubric:\n{rubric_text}\n\n"
            f"Response A:\n{a}\n\nResponse B:\n{b}\n\n"
            "Score how much A beats B with `SCORE: <0..1>` (1 = A clearly better, "
            "0 = B clearly better, 0.5 = tie)."
        )

    r_ab = extract(judge(_prompt(candidate_output, incumbent_output)))
    r_ba = extract(judge(_prompt(incumbent_output, candidate_output)))
    return max(0.0, min(1.0, (r_ab - r_ba + 1.0) / 2.0))


def judge_human_agreement(
    judge_labels: list[Any], human_labels: list[Any]
) -> float:
    """Fraction of items where the judge agrees with the human gold.

    The readiness gate for trusting a rubric judge: low agreement means the
    rubric or judge is miscalibrated — fix it before optimizing against it.
    """
    if len(judge_labels) != len(human_labels) or not judge_labels:
        raise ValueError("judge_labels and human_labels must be same non-zero length")
    agree = sum(1 for j, h in zip(judge_labels, human_labels) if j == h)
    return agree / len(judge_labels)
