"""Build auditable dev comparison, selection, and latency/cost artifacts."""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"


def _summary(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def _warm_summary(label: str) -> dict[str, Any]:
    summary = _summary(ARTIFACT_DIR / f"{label}-dev-warm.summary.json")
    rows = [
        json.loads(line)
        for line in (ARTIFACT_DIR / f"{label}-dev-warm.jsonl").read_text().splitlines()
        if line.strip()
    ]
    per_pass: list[dict[str, Any]] = []
    for pass_index in sorted({row["pass_index"] for row in rows}):
        current = [row for row in rows if row["pass_index"] == pass_index]
        turn_latencies = [
            latency
            for row in current
            for latency in row["sampling_latencies_seconds"]
        ]
        task_latencies = [row["sampling_latency_seconds_total"] for row in current]
        per_pass.append(
            {
                "pass_index": pass_index,
                "mean_per_turn_sampling_latency_seconds": statistics.fmean(
                    turn_latencies
                ),
                "mean_per_task_sampling_latency_seconds": statistics.fmean(
                    task_latencies
                ),
                "stddev_per_task_sampling_latency_seconds": (
                    statistics.pstdev(task_latencies)
                    if len(task_latencies) > 1
                    else 0.0
                ),
                "mean_reward": statistics.fmean(row["score"] for row in current),
                "strict_pass_rate": sum(row["score"] == 1.0 for row in current)
                / len(current),
            }
        )
    summary["per_pass"] = per_pass
    summary["across_pass_variance"] = {
        "mean_per_task_sampling_latency_seconds": statistics.pvariance(
            row["mean_per_task_sampling_latency_seconds"] for row in per_pass
        ),
        "mean_per_turn_sampling_latency_seconds": statistics.pvariance(
            row["mean_per_turn_sampling_latency_seconds"] for row in per_pass
        ),
    }
    summary["label"] = label
    return summary


def _entry(label: str, summary: dict[str, Any], summary_path: Path) -> dict[str, Any]:
    return {
        "label": label,
        "model": summary["model"],
        "model_path": summary["model_path"],
        "base_model": summary["base_model"],
        "renderer": summary["renderer"],
        "serving_contract": summary["serving_contract"],
        "mean_reward": summary["mean_reward"],
        "strict_pass_rate": summary["strict_pass_rate"],
        "per_band": summary["per_band"],
        "mean_model_turns": summary["mean_model_turns"],
        "mean_per_turn_sampling_latency_seconds": summary[
            "mean_per_turn_sampling_latency_seconds"
        ],
        "p50_per_turn_sampling_latency_seconds": summary[
            "p50_per_turn_sampling_latency_seconds"
        ],
        "mean_per_task_sampling_latency_seconds": summary[
            "mean_per_task_sampling_latency_seconds"
        ],
        "mean_prompt_plus_sampled_tokens": summary[
            "mean_prompt_plus_sampled_tokens"
        ],
        "parse_error_rate": summary["parse_error_rate"],
        "total_prompt_tokens": summary["total_prompt_tokens"],
        "total_sampled_tokens": summary["total_sampled_tokens"],
        "summary_path": str(summary_path.relative_to(EXPERIMENT_DIR)),
        "receipt_path": str(
            Path(str(summary_path).replace(".summary.json", ".usage.json")).relative_to(
                EXPERIMENT_DIR
            )
        ),
    }


def main() -> None:
    paths = {
        "teacher": ARTIFACT_DIR / "teacher-dev.summary.json",
        "student-base": ARTIFACT_DIR / "student-base-dev.summary.json",
        "student-sft-epoch1": ARTIFACT_DIR / "student-sft-epoch1-dev.summary.json",
        "student-sft-epoch2": ARTIFACT_DIR / "student-sft-epoch2-dev.summary.json",
        "student-sft-epoch3": ARTIFACT_DIR / "student-sft-epoch3-dev.summary.json",
        "student-sft-epoch4": ARTIFACT_DIR / "student-sft-epoch4-dev.summary.json",
    }
    summaries = {label: _summary(path) for label, path in paths.items()}
    entries = [_entry(label, summaries[label], paths[label]) for label in paths]
    (ARTIFACT_DIR / "dev-table.json").write_text(
        json.dumps(
            {
                "schema_version": "understudy.dev_comparison.v1",
                "split": "dev",
                "task_count": 12,
                "entries": entries,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )

    epochs = [
        entry for entry in entries if entry["label"].startswith("student-sft-epoch")
    ]
    selected = min(
        epochs,
        key=lambda entry: (-entry["mean_reward"], int(entry["label"].rsplit("epoch", 1)[1])),
    )
    selection = {
        "schema_version": "understudy.model_selection.v1",
        "split": "dev",
        "selection_rule": "highest DEV mean reward; earliest epoch tie-break",
        "selected_model": selected["label"],
        "selected_epoch": int(selected["label"].rsplit("epoch", 1)[1]),
        "selected_adapter_path": selected["model_path"],
        "selected_mean_reward": selected["mean_reward"],
        "student_base_mean_reward": summaries["student-base"]["mean_reward"],
        "teacher_mean_reward": summaries["teacher"]["mean_reward"],
        "lift_over_student_base": selected["mean_reward"]
        - summaries["student-base"]["mean_reward"],
        "holdout_accessed": False,
        "dev_table": "artifacts/dev-table.json",
    }
    (ARTIFACT_DIR / "selection.json").write_text(
        json.dumps(selection, indent=2, sort_keys=True) + "\n"
    )

    teacher = _entry("teacher", summaries["teacher"], paths["teacher"])
    student = selected
    warm_labels = {
        "teacher": "teacher",
        "student_base": "student-base",
        "selected_student": "student-sft-epoch1",
    }
    warm = {
        key: _warm_summary(label)
        for key, label in warm_labels.items()
    }
    delta = {
        "schema_version": "understudy.latency_cost_delta.v1",
        "split": "dev",
        "cold_start": {
            "note": "The cold-start gap was an adapter-attach/first-request artifact, not steady-state serving cost.",
            "teacher": teacher,
            "selected_student": student,
        },
        "warm_start": {
            "protocol": {
                "warmup_rollouts_per_sampling_client": 1,
                "timed_passes": 3,
                "tasks_per_pass": 12,
                "temperature": 0.0,
                "warmup_timings_excluded": True,
            },
            "teacher": warm["teacher"],
            "student_base": warm["student_base"],
            "selected_student": warm["selected_student"],
            "comparison": {
                "mean_per_turn_sampling_latency_seconds": {
                    "teacher": warm["teacher"][
                        "mean_per_turn_sampling_latency_seconds"
                    ],
                    "student": warm["selected_student"][
                        "mean_per_turn_sampling_latency_seconds"
                    ],
                },
                "p50_per_turn_sampling_latency_seconds": {
                    "teacher": warm["teacher"][
                        "p50_per_turn_sampling_latency_seconds"
                    ],
                    "student": warm["selected_student"][
                        "p50_per_turn_sampling_latency_seconds"
                    ],
                },
                "p90_per_turn_sampling_latency_seconds": {
                    "teacher": warm["teacher"][
                        "per_turn_latency_distribution_seconds"
                    ]["p90"],
                    "student": warm["selected_student"][
                        "per_turn_latency_distribution_seconds"
                    ]["p90"],
                },
                "mean_per_task_sampling_latency_seconds": {
                    "teacher": warm["teacher"][
                        "mean_per_task_sampling_latency_seconds"
                    ],
                    "student": warm["selected_student"][
                        "mean_per_task_sampling_latency_seconds"
                    ],
                },
                "mean_model_turns": {
                    "teacher": warm["teacher"]["mean_model_turns"],
                    "student": warm["selected_student"]["mean_model_turns"],
                },
                "mean_prompt_plus_sampled_tokens": {
                    "teacher": warm["teacher"][
                        "mean_prompt_plus_sampled_tokens"
                    ],
                    "student": warm["selected_student"][
                        "mean_prompt_plus_sampled_tokens"
                    ],
                },
                "parse_error_rate": {
                    "teacher": warm["teacher"]["parse_error_rate"],
                    "student": warm["selected_student"]["parse_error_rate"],
                },
            },
        },
        "cost": {
            "teacher": {"usd": None, "basis": "tinker_billing_usage"},
            "student": {"usd": None, "basis": "tinker_billing_usage"},
            "note": "Billing receipts contained no dollar-valued events; no prices were synthesized.",
        },
        "model_size_caveat": (
            "Teacher is a 30B-A3B MoE with approximately 3B active parameters; "
            "student is a dense 9B. A latency or cost win is not automatic."
        ),
        "receipts": {
            "teacher": "artifacts/teacher-dev-warm.usage.json",
            "student": "artifacts/student-sft-epoch1-dev-warm.usage.json",
        },
    }
    (ARTIFACT_DIR / "latency-cost-delta.json").write_text(
        json.dumps(delta, indent=2, sort_keys=True) + "\n"
    )


if __name__ == "__main__":
    main()
