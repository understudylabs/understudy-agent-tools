"""Prove the sealed-holdout verdict fails closed for every guardrail."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from sealed_holdout import _verdict

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
TOLERANCE_PATH = ARTIFACT_DIR / "holdout-tolerance.json"
OUT_PATH = ARTIFACT_DIR / "holdout-verdict-smoke.json"


def _rows() -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for model in ("teacher", "student-base", "student-sft"):
        rows = []
        for index in range(12):
            rows.append(
                {
                    "task_id": f"synthetic-{index}",
                    "band": ("single-write", "discovery", "multi-write")[index // 4],
                    "reward": 1.0,
                    "parse_errors": [],
                    "model_turns": 1,
                    "sampling_latencies_seconds": [1.0],
                    "sampling_latency_seconds_total": 1.0,
                    "prompt_token_counts": [10],
                    "sampled_token_counts": [5],
                }
            )
        result[model] = rows
    return result


def _run_case(
    name: str, mutate: Any, tolerance: dict[str, Any]
) -> dict[str, Any]:
    rows = _rows()
    mutate(rows)
    verdict = _verdict(rows, tolerance)
    if verdict["verdict"] != "FAIL":
        raise AssertionError(f"{name} unexpectedly returned {verdict['verdict']}")
    return {"case": name, "verdict": verdict}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(OUT_PATH))
    args = parser.parse_args()
    tolerance = json.loads(TOLERANCE_PATH.read_text())
    control = _verdict(_rows(), tolerance)
    if control["verdict"] != "PASS":
        raise AssertionError("synthetic all-pass control did not return PASS")

    cases = [
        _run_case(
            "overall_deficit_gt_0.084",
            lambda rows: [
                rows["student-sft"][index].update(reward=0.0)
                for index in (0, 1)
            ],
            tolerance,
        ),
        _run_case(
            "per_band_deficit_gt_0.25",
            lambda rows: [
                rows["student-sft"][index].update(reward=0.0)
                for index in (0, 1)
            ],
            tolerance,
        ),
        _run_case(
            "student_hard_fails_exceed_teacher_plus_one",
            lambda rows: [
                rows["student-sft"][index].update(reward=0.0)
                for index in (0, 1)
            ],
            tolerance,
        ),
        _run_case(
            "student_parse_error_rate_gt_0.1",
            lambda rows: [
                rows["student-sft"][index].update(parse_errors=["synthetic-error"])
                for index in (0, 1)
            ],
            tolerance,
        ),
    ]
    result = {
        "schema_version": "understudy.holdout_verdict_smoke.v1",
        "control": control,
        "cases": cases,
        "all_fail_paths_proven": True,
        "tolerance_verdict_rule": tolerance["verdict_rule"],
    }
    Path(args.out).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"out": args.out, "cases": len(cases)}))


if __name__ == "__main__":
    main()
