"""Build auditable dev comparison, selection, and latency/cost artifacts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"


def _summary(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


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
    delta = {
        "schema_version": "understudy.latency_cost_delta.v1",
        "split": "dev",
        "teacher": teacher,
        "selected_student": student,
        "comparison": {
            "mean_per_turn_sampling_latency_seconds": {
                "teacher": teacher["mean_per_turn_sampling_latency_seconds"],
                "student": student["mean_per_turn_sampling_latency_seconds"],
            },
            "p50_per_turn_sampling_latency_seconds": {
                "teacher": teacher["p50_per_turn_sampling_latency_seconds"],
                "student": student["p50_per_turn_sampling_latency_seconds"],
            },
            "mean_per_task_sampling_latency_seconds": {
                "teacher": teacher["mean_per_task_sampling_latency_seconds"],
                "student": student["mean_per_task_sampling_latency_seconds"],
            },
            "mean_model_turns": {
                "teacher": teacher["mean_model_turns"],
                "student": student["mean_model_turns"],
            },
            "mean_prompt_plus_sampled_tokens": {
                "teacher": teacher["mean_prompt_plus_sampled_tokens"],
                "student": student["mean_prompt_plus_sampled_tokens"],
            },
            "parse_error_rate": {
                "teacher": teacher["parse_error_rate"],
                "student": student["parse_error_rate"],
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
            "teacher": teacher["receipt_path"],
            "student": student["receipt_path"],
        },
    }
    (ARTIFACT_DIR / "latency-cost-delta.json").write_text(
        json.dumps(delta, indent=2, sort_keys=True) + "\n"
    )


if __name__ == "__main__":
    main()
