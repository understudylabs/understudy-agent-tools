"""Select the earliest best DPO checkpoint using sealed dev scores."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metrics", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    candidates = []
    for path in args.metrics:
        summary = json.loads(Path(path).read_text())
        candidates.append(
            {
                "epoch": int(summary["label"].rsplit("epoch", 1)[-1]),
                "label": summary["label"],
                "path": summary["model_path"],
                "mean_reward": float(summary["mean_reward"]),
                "per_band": summary["per_band"],
                "summary_path": str(Path(path).resolve()),
            }
        )
    selected = min(candidates, key=lambda row: (-row["mean_reward"], row["epoch"]))
    result = {
        "selection_rule": "maximize dev mean reward; tie-break toward earliest checkpoint",
        "rationale": "Preserves the #402 GRPO selection convention and minimizes unnecessary policy drift.",
        "selection_recorded_before_holdout": True,
        "split": "dev",
        "candidates": sorted(candidates, key=lambda row: row["epoch"]),
        "selected": selected,
    }
    Path(args.out).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
