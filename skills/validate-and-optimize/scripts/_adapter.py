#!/usr/bin/env python3
"""`gepa.GEPAAdapter` over the developer's own provider + the confirmed metric.

This is the live-execution adapter (follow-up to the MVP gates). It implements
the upstream `gepa` adapter protocol so `gepa.optimize` can evolve a prompt:

    evaluate(batch, candidate, capture_traces) -> EvaluationBatch
    make_reflective_dataset(candidate, eval_batch, components_to_update) -> Mapping

`candidate` is `dict[str, str]` — the named text components GEPA evolves
(`{"prompt": ...}` for a single prompt; multiple keys for a multi-step pipeline,
e.g. `{"planner_prompt": ..., "solver_prompt": ...}`).

**Turn model — single-turn and multi-turn both work, because `infer` *is* the
system.** The adapter does not assume one prompt → one string. It hands the
whole `candidate` dict to the injected `infer`, which runs the workload however
it actually runs — a single completion, or a multi-turn agent / tool-use loop —
and returns whatever the workload produces (a string, or a full trajectory).
`metric` then scores that output, which for multi-turn means scoring a trajectory
(tool-call sequence, final-state validation). The only thing out of scope here is
a **stateful RL environment** (interactive reward); that's the verifier rung,
deferred (see the skill's reference.md).

Inference and scoring are **injected** so the adapter is provider-agnostic and
unit-testable without gepa or network:
- `infer(candidate, example) -> output` — runs the workload (single- or
  multi-turn) on the developer's own keys, wiring the candidate's components in
  wherever the system uses them. Wire to the tool's provider/route plumbing
  (`route_decision.py`); this is the substantive remaining integration.
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
Output = Any  # a string (single-turn) or a trajectory (multi-turn)
InferFn = Callable[[dict[str, str], Example], Output]
MetricFn = Callable[[Example, Output], "tuple[float, str]"]


class UnderstudyGepaAdapter:
    """Adapter conforming to `gepa.GEPAAdapter`."""

    def __init__(self, *, infer: InferFn, metric: MetricFn) -> None:
        self._infer = infer
        self._metric = metric

    def evaluate(
        self,
        batch: list[Example],
        candidate: dict[str, str],
        capture_traces: bool = False,
    ) -> "EvaluationBatch":
        outputs: list[Output] = []
        scores: list[float] = []
        trajectories: list[dict[str, Any]] | None = [] if capture_traces else None
        for example in batch:
            # `infer` owns how the candidate's components drive the workload —
            # one call or a full multi-turn loop — and returns its output.
            output = self._infer(candidate, example)
            score, feedback = self._metric(example, output)
            outputs.append(output)
            scores.append(float(score))
            if trajectories is not None:
                trajectories.append(
                    {
                        "example": example,
                        "candidate": candidate,
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
