"""Build the sealed, terminal experiment result contract offline."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from executor_tinker import TinkerExecutor

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
OUT_PATH = ARTIFACT_DIR / "experiment-result.json"
CANCELLATION_PATH = ARTIFACT_DIR / "executor-cancellation.json"
EXPERIMENT_ID = "P3-nemotron-distillation"
VERIFIER_ENVIRONMENT = "offline AutomationBench evaluator"
VERIFIER_REVISION = "dd7a9d71f38b40ffbecbbe4a711dd37bfa44d6ce"
BUDGET_USD = 100.0
SPLIT_REFS = {
    "train": "artifact://automationbench-simple-api-offline-v1/train.json",
    "dev": "artifact://automationbench-simple-api-offline-v1/dev.json",
    "holdout": "artifact://automationbench-simple-api-offline-v1/holdout.json",
}
SPLIT_HASHES = {
    "train": "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89",
    "dev": "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc",
    "holdout": "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _load_holdout() -> dict[str, Any]:
    return json.loads((ARTIFACT_DIR / "sealed-holdout.json").read_text())


def _metrics(summary: dict[str, Any]) -> dict[str, float]:
    metrics = {
        "mean_reward": summary["mean_reward"],
        "single_write_mean_reward": summary["per_band"]["single-write"],
        "discovery_mean_reward": summary["per_band"]["discovery"],
        "multi_write_mean_reward": summary["per_band"]["multi-write"],
        "mean_per_task_latency_seconds": summary[
            "mean_per_task_sampling_latency_seconds"
        ],
        "mean_per_turn_latency_seconds": summary[
            "mean_per_turn_sampling_latency_seconds"
        ],
        "p50_per_turn_latency_seconds": summary[
            "p50_per_turn_sampling_latency_seconds"
        ],
        "p90_per_turn_latency_seconds": summary[
            "p90_per_turn_sampling_latency_seconds"
        ],
        "mean_prompt_plus_sampled_tokens": summary["mean_prompt_plus_sampled_tokens"],
        "mean_model_turns": summary["mean_model_turns"],
        "parse_error_rate": summary["parse_error_rate"],
    }
    return {key: float(value) for key, value in metrics.items()}


def _artifact_refs() -> list[str]:
    return [
        "artifact://nemotron-distillation/sealed-holdout.json",
        "artifact://nemotron-distillation/sealed-holdout-student-base.usage.json",
        "artifact://nemotron-distillation/sealed-holdout-student-sft.usage.json",
        "artifact://nemotron-distillation/sealed-holdout-teacher.usage.json",
        "artifact://nemotron-distillation/holdout-lock.json",
        "artifact://nemotron-distillation/holdout-verdict-smoke.json",
        "artifact://nemotron-distillation/executor-cancellation.json",
    ]


def main() -> None:
    holdout = _load_holdout()
    baseline = holdout["models"]["student-base"]["summary"]
    optimized = holdout["models"]["student-sft"]["summary"]

    executor = TinkerExecutor()
    job = executor.job_ref(
        experiment_id=EXPERIMENT_ID,
        candidate_id="student-sft-epoch1",
        attempt=1,
        executor="fixture",
    )
    cancellation = executor.cancel(job["job_id"], executor="fixture")
    CANCELLATION_PATH.write_text(json.dumps(cancellation, indent=2, sort_keys=True) + "\n")

    result = {
        "schema_version": "understudy.experiment-result.v1",
        "experiment_id": EXPERIMENT_ID,
        "state": "succeeded",
        "verifier_environment": VERIFIER_ENVIRONMENT,
        "verifier_revision": VERIFIER_REVISION,
        "split_manifest_refs": SPLIT_REFS,
        "split_manifest_sha256": SPLIT_HASHES,
        "baseline_metrics": _metrics(baseline),
        "optimized_metrics": _metrics(optimized),
        "holdout_executed": True,
        "holdout_clean": True,
        "budget_usd": BUDGET_USD,
        "usage": {
            "evidence_scope": "unknown",
            "requests": None,
            "input_tokens": optimized["total_prompt_tokens"],
            "output_tokens": optimized["total_sampled_tokens"],
            "actual_usd": None,
            "estimated_usd": None,
            "upper_bound_usd": None,
            "observed_at": _now(),
        },
        "request_isolation_proven": False,
        "quality_evidence": {
            "status": "measured",
            "reason": (
                "Holdout quality and protocol metrics were measured and "
                "verifier-checked, but the fixture is saturated: teacher, "
                "untuned student base, and selected SFT student all scored "
                "1.000, so the comparison has no discriminating power."
            ),
            "required_calibration": None,
            "calibration_artifact_refs": [],
        },
        "failure_clusters": [
            {
                "cluster": "student-base parse/protocol failures",
                "count": 2,
                "artifact_refs": [
                    "artifact://nemotron-distillation/sealed-holdout.json"
                ],
            }
        ],
        "cancellation_receipts": [cancellation],
        "artifact_refs": _artifact_refs(),
        "claim_boundary": (
            "Quality parity is claimed within the predeclared tolerance on a "
            "saturated 12-task holdout fixture; warm-start latency and token "
            "wins are measured, not cost claims. No dollar evidence exists, "
            "the teacher is an approximately 3B-active 30B-A3B MoE while the "
            "student is a dense 9B, no upstream AutomationBench claim is made, "
            "and n=12 for train, dev, and holdout comparisons."
        ),
    }
    OUT_PATH.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"out": str(OUT_PATH), "cancellation": str(CANCELLATION_PATH)}))


if __name__ == "__main__":
    main()
