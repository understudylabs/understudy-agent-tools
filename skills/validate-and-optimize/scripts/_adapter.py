#!/usr/bin/env python3
"""`gepa.GEPAAdapter` over the developer's own provider + the confirmed metric.

This is the live-execution adapter (follow-up to the MVP gates). It implements
the upstream `gepa` adapter protocol so `gepa.optimize` can evolve a prompt:

    evaluate(batch, candidate, capture_traces) -> EvaluationBatch
    make_reflective_dataset(candidate, eval_batch, components_to_update) -> Mapping

`candidate` is `dict[str, str]` — named text components (default `{"prompt": ...}`).

Inference and scoring are **injected** so the adapter is provider-agnostic and
unit-testable without gepa or network:
- `infer(rendered_prompt, example) -> output_text` — runs the candidate on the
  developer's own keys. Wire this to the tool's provider/route plumbing
  (`route_decision.py`); it is the substantive remaining integration.
- `metric(example, output) -> (score, feedback)` — the human-confirmed validator
  from `metric.json`. `feedback` is the natural-language diagnosis GEPA reflects
  on; it must say *why* the output failed and what to change, not a bare score.

`gepa` is imported lazily (it is a detect-and-prompt dependency, not a hard dep);
import this module only on the real-run path after confirming gepa is available.
"""
from __future__ import annotations

from typing import Any, Callable

from gepa import EvaluationBatch  # lazy: only import this module when gepa is present

Example = dict[str, Any]
InferFn = Callable[[str, Example], str]
MetricFn = Callable[[Example, str], "tuple[float, str]"]
RenderFn = Callable[[str, Example], str]


class UnderstudyGepaAdapter:
    """Adapter conforming to `gepa.GEPAAdapter`."""

    def __init__(
        self,
        *,
        infer: InferFn,
        metric: MetricFn,
        render: RenderFn | None = None,
        component: str = "prompt",
    ) -> None:
        self._infer = infer
        self._metric = metric
        # Default render is identity: the candidate prompt is sent as-is. Provide
        # a real template renderer when the workload interpolates example inputs.
        self._render = render or (lambda template, _example: template)
        self._component = component

    def evaluate(
        self,
        batch: list[Example],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> "EvaluationBatch":
        prompt = candidate[self._component]
        outputs: list[str] = []
        scores: list[float] = []
        trajectories: list[dict[str, Any]] | None = [] if capture_traces else None
        for example in batch:
            rendered = self._render(prompt, example)
            output = self._infer(rendered, example)
            score, feedback = self._metric(example, output)
            outputs.append(output)
            scores.append(float(score))
            if trajectories is not None:
                trajectories.append(
                    {
                        "example": example,
                        "prompt": rendered,
                        "output": output,
                        "score": float(score),
                        "feedback": feedback,
                    }
                )
        return EvaluationBatch(
            outputs=outputs,
            scores=scores,
            trajectories=trajectories,
            objective_scores=None,
        )

    def make_reflective_dataset(
        self,
        candidate: dict[str, str],
        eval_batch: "EvaluationBatch",
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        # GEPA's reflection_lm reads these records to propose a better component.
        # Surfacing the validator's feedback (the diagnosis) is the whole point;
        # an empty/uninformative feedback string wastes the optimizer.
        records: list[dict[str, Any]] = []
        for traj in eval_batch.trajectories or []:
            records.append(
                {
                    "Inputs": traj["example"],
                    "Generated Output": traj["output"],
                    "Feedback": traj["feedback"],
                    "Score": traj["score"],
                }
            )
        return {component: records for component in components_to_update}
