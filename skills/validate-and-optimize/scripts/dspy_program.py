#!/usr/bin/env python3
"""DSPy-program optimization lane (opt-in).

Scaffolds a DSPy program from the Workload Card + sample data, then lets
`dspy.GEPA` optimize it natively — instructions across predictors **plus**
few-shot demos bootstrapped from the data, and `dspy.ReAct` for multi-turn
tool-use. This is the richer, opt-in lane; the default lane optimizes the
developer's real prompt in place (see `_adapter.py`).

⚠️ The scaffolded program is a *reconstruction* of the workload, not the user's
real call site. Optimizing a reconstruction that diverges from production is the
`synthetic-optimizer-before-real-harness-attachment` failure. So the lane is
**gated by `parity_check`**: the program must reproduce the incumbent baseline on
the holdout before GEPA is allowed to touch it.

`dspy` is imported lazily (optional install, MIT); import this module only on the
opt-in DSPy path. Inference is driven by the dspy-configured LM (the developer's
own keys); tests use `dspy.utils.DummyLM`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence

import dspy

# A dspy metric: (example, prediction[, trace, pred_name, pred_trace]) -> a float
# in [0,1], OR a `dspy.Prediction(score=..., feedback=...)` to give GEPA
# natural-language feedback (preferred). Typed Any because the Prediction form
# can't be referenced here (dspy is lazily imported).
Metric = Callable[..., Any]


def build_signature(
    input_fields: Sequence[str],
    output_fields: Sequence[str],
    *,
    instructions: str = "",
) -> type:
    """Dynamic DSPy Signature from the Workload Card's field names."""
    if not input_fields or not output_fields:
        raise ValueError("need at least one input and one output field")
    spec = f"{', '.join(input_fields)} -> {', '.join(output_fields)}"
    return dspy.Signature(spec, instructions) if instructions else dspy.Signature(spec)


def build_program(
    input_fields: Sequence[str],
    output_fields: Sequence[str],
    *,
    module: str = "predict",
    tools: list[Callable[..., Any]] | None = None,
    instructions: str = "",
) -> "dspy.Module":
    """Build the program. `react` (with tools) for multi-turn tool-use; otherwise
    `predict` or `cot`. ReAct gives multi-turn for free — GEPA then evolves the
    instructions + tool descriptions across the loop."""
    sig = build_signature(input_fields, output_fields, instructions=instructions)
    if module == "react":
        if not tools:
            raise ValueError("module='react' requires tools")
        return dspy.ReAct(sig, tools=tools)
    if module == "cot":
        return dspy.ChainOfThought(sig)
    return dspy.Predict(sig)


def examples_from_rows(
    rows: Sequence[dict[str, Any]], input_keys: Sequence[str]
) -> list["dspy.Example"]:
    """Map sample rows → dspy.Example trainset (inputs marked)."""
    out: list[dspy.Example] = []
    for row in rows:
        out.append(dspy.Example(**row).with_inputs(*input_keys))
    return out


@dataclass
class ParityResult:
    parity: bool
    program_score: float
    baseline_score: float
    delta: float
    tolerance: float
    n: int


def parity_check(
    program: "dspy.Module",
    holdout: Sequence["dspy.Example"],
    metric: Metric,
    *,
    baseline_score: float,
    input_keys: Sequence[str],
    tolerance: float = 0.05,
) -> ParityResult:
    """Gate: does the scaffolded program reproduce the incumbent on holdout?

    Runs the program on each holdout example, means the metric, and compares to
    the incumbent `baseline_score`. parity fails if the program is worse than
    baseline by more than `tolerance` — meaning the reconstruction diverges from
    production and must be fixed before optimizing (else you optimize a fiction).
    """
    if not holdout:
        raise ValueError("parity_check needs a non-empty holdout")
    scores: list[float] = []
    for ex in holdout:
        pred = program(**{k: ex[k] for k in input_keys})
        scores.append(float(metric(ex, pred)))
    program_score = sum(scores) / len(scores)
    delta = program_score - baseline_score
    return ParityResult(
        parity=delta >= -tolerance,
        program_score=program_score,
        baseline_score=baseline_score,
        delta=delta,
        tolerance=tolerance,
        n=len(scores),
    )


def resolve_lm(model: str):
    """The lane's default LM: **Understudy inference if logged in, else BYO**.

    Delegates to `understudy_agent_tools.inference.build_dspy_lm`, which routes
    through the Understudy gateway when a credential is present and otherwise
    builds a native `provider/model` LM on the developer's own keys.
    """
    from understudy_agent_tools.inference import build_dspy_lm

    return build_dspy_lm(model)


def optimize(
    program: "dspy.Module",
    *,
    trainset: Sequence["dspy.Example"],
    valset: Sequence["dspy.Example"],
    metric: Metric,
    reflection_lm: Any | None = None,
    reflection_model: str | None = None,
    auto: str = "light",
    **gepa_kwargs: Any,
) -> "dspy.Module":
    """Compile with dspy.GEPA (instructions + bootstrapped demos).

    Caller MUST have passed `parity_check` first. `metric` may return a
    `dspy.Prediction(score=..., feedback=...)` to give GEPA natural-language
    feedback (preferred) instead of a bare float.

    By default the reflection LM is resolved Understudy-first: pass
    `reflection_model` (a model name) and it routes through Understudy inference
    when logged in, else BYO. Pass an explicit `reflection_lm` to override.
    """
    if reflection_lm is None:
        if reflection_model is None:
            raise ValueError("pass reflection_lm or reflection_model")
        reflection_lm = resolve_lm(reflection_model)
    optimizer = dspy.GEPA(metric=metric, reflection_lm=reflection_lm, auto=auto, **gepa_kwargs)
    return optimizer.compile(program, trainset=list(trainset), valset=list(valset))
