"""Select a GRPO checkpoint using raw dev-only metrics."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any


EXPERIMENT_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
LABELS = ("r32-none", "r32-shaped", "r16-shaped")


def _records(label: str) -> list[dict[str, Any]]:
    curve = ARTIFACT_DIR / f"{label}-dev-curve.jsonl"
    checkpoints = ARTIFACT_DIR / f"{label}-grpo-log" / "checkpoints.jsonl"
    if not curve.exists():
        return []
    checkpoint_rows = (
        [json.loads(line) for line in checkpoints.read_text().splitlines() if line.strip()]
        if checkpoints.exists()
        else []
    )
    result = []
    for row in curve.read_text().splitlines():
        if not row.strip():
            continue
        dev = json.loads(row)
        preceding = [
            checkpoint
            for checkpoint in checkpoint_rows
            if int(checkpoint.get("batch", -1)) <= int(dev["step"])
            and checkpoint.get("sampler_path")
        ]
        checkpoint = max(preceding, key=lambda item: int(item["batch"])) if preceding else None
        if checkpoint is None:
            continue
        result.append(
            {
                "label": label,
                "step": dev["step"],
                "sampler_path": checkpoint.get("sampler_path") if checkpoint else None,
                "raw_dev_mean": dev["mean_reward"],
                "mean_env_steps": dev["mean_env_steps"],
                "forbidden_effect_rate": dev["forbidden_effect_rate"],
                "strict_pass_rate": dev["strict_pass_rate"],
                "summary_path": str(curve),
            }
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    args = parser.parse_args()
    leaderboard = [row for label in LABELS for row in _records(label)]
    if not leaderboard:
        raise SystemExit("no completed dev curves found")
    leaderboard.sort(
        key=lambda row: (
            -row["raw_dev_mean"],
            row["mean_env_steps"],
            row["forbidden_effect_rate"],
            row["step"],
        )
    )
    output = Path(args.out) if args.out else ARTIFACT_DIR / f"selection-{int(time.time())}.json"
    output.write_text(
        json.dumps(
            {
                "selection_rule": [
                    "highest raw dev mean partialCredit",
                    "lower mean env_steps",
                    "fewer dev forbidden effects",
                    "earliest step",
                ],
                "holdout_accessed": False,
                "leaderboard": leaderboard,
                "selected": leaderboard[0],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    print(json.dumps({"out": str(output), "selected": leaderboard[0]}, indent=2))


if __name__ == "__main__":
    main()
