"""Build evaluator-scored train-only preference pairs from sampled rollouts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from statistics import fmean, median
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parent
REPO = EXPERIMENT_DIR.parents[1]
SIBLING_DIR = REPO / "experiments" / "nemotron-tinker-grpo"
if str(SIBLING_DIR) not in sys.path:
    # Reuse the #402 rollout/evaluator implementation without copying it.
    sys.path.insert(0, str(SIBLING_DIR))

from rollout import MODEL_NAME, RENDERER_NAME  # noqa: E402

SFT_SAMPLER = (
    "tinker://e3e3d392-c8f0-5889-9f91-423a28a12163:train:0/"
    "sampler_weights/sft-epoch4"
)
BASE_SAMPLER = "base"
PAIR_TARGET = 12
SAMPLES_PER_TASK = 8


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, default=EXPERIMENT_DIR / "artifacts")
    parser.add_argument("--sft-model-path", default=SFT_SAMPLER)
    parser.add_argument("--base-model-path", default=BASE_SAMPLER)
    parser.add_argument("--min-pairs", type=int, default=PAIR_TARGET)
    parser.add_argument("--concurrency", type=int, default=8)
    return parser.parse_args()


def _run_source(
    source: str,
    model_path: str,
    out_dir: Path,
    concurrency: int,
) -> list[dict[str, Any]]:
    out = out_dir / f"dpo-rollouts-{source}.jsonl"
    command = [
        sys.executable,
        str(SIBLING_DIR / "evaluate.py"),
        "--split",
        "train",
        "--model-path",
        model_path,
        "--label",
        f"dpo-pairs-{source}",
        "--temperature",
        "1.0",
        "--samples",
        str(SAMPLES_PER_TASK),
        "--concurrency",
        str(concurrency),
        "--out",
        str(out),
    ]
    subprocess.run(command, cwd=REPO, check=True)
    return [json.loads(line) for line in out.read_text().splitlines() if line.strip()]


def _completion_pair(row: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    messages = row["messages"]
    if len(messages) < 2:
        raise ValueError(f"rollout has no prompt messages: {row['task_id']}")
    return messages[:2], messages[2:]


def _pair_rows(rows_by_source: dict[str, list[dict[str, Any]]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    by_task: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for source, rows in rows_by_source.items():
        for row in rows:
            if row.get("split") != "train":
                raise RuntimeError(f"non-train row reached pair builder: {row.get('task_id')}")
            by_task.setdefault(row["task_id"], []).append((source, row))

    pairs: list[dict[str, Any]] = []
    degenerate: list[str] = []
    source_counts: Counter[str] = Counter()
    band_counts: Counter[str] = Counter()
    gaps: list[float] = []
    for task_id, candidates in sorted(by_task.items()):
        rewards = [float(row["score"]) for _, row in candidates]
        if min(rewards) == max(rewards):
            degenerate.append(task_id)
            continue
        chosen_source, chosen = max(candidates, key=lambda item: float(item[1]["score"]))
        rejected_source, rejected = min(candidates, key=lambda item: float(item[1]["score"]))
        prompt, chosen_completion = _completion_pair(chosen)
        rejected_prompt, rejected_completion = _completion_pair(rejected)
        if prompt != rejected_prompt:
            raise RuntimeError(f"prompt mismatch within task {task_id}")
        gap = float(chosen["score"]) - float(rejected["score"])
        pair = {
            "task_id": task_id,
            "split": "train",
            "family": chosen["family"],
            "band": chosen["band"],
            "chosen_reward": float(chosen["score"]),
            "rejected_reward": float(rejected["score"]),
            "reward_gap": gap,
            "chosen_source": chosen_source,
            "rejected_source": rejected_source,
            "prompt_conversation": prompt,
            "chosen": chosen_completion,
            "rejected": rejected_completion,
        }
        pairs.append(pair)
        source_counts[f"{chosen_source}->{rejected_source}"] += 1
        band_counts[chosen["band"]] += 1
        gaps.append(gap)
    summary = {
        "model_name": MODEL_NAME,
        "renderer": RENDERER_NAME,
        "split": "train",
        "samples_per_task": SAMPLES_PER_TASK,
        "sources": sorted(rows_by_source),
        "task_count": len(by_task),
        "pair_count": len(pairs),
        "degenerate_task_count": len(degenerate),
        "degenerate_task_ids": degenerate,
        "pair_source_counts": dict(sorted(source_counts.items())),
        "pair_band_counts": dict(sorted(band_counts.items())),
        "reward_gap": {
            "min": min(gaps) if gaps else 0.0,
            "max": max(gaps) if gaps else 0.0,
            "mean": fmean(gaps) if gaps else 0.0,
            "median": median(gaps) if gaps else 0.0,
        },
    }
    return pairs, summary


def main() -> None:
    args = _args()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    rows_by_source = {"sft": _run_source("sft", args.sft_model_path, out_dir, args.concurrency)}
    pairs, summary = _pair_rows(rows_by_source)
    if len(pairs) < args.min_pairs:
        rows_by_source["base"] = _run_source("base", args.base_model_path, out_dir, args.concurrency)
        pairs, summary = _pair_rows(rows_by_source)
    summary["fallback_used"] = "base" in rows_by_source
    summary["configured_min_pairs"] = args.min_pairs
    summary["source_model_paths"] = {
        "sft": args.sft_model_path,
        "base": args.base_model_path,
    }
    summary_path = out_dir / "dpo-pairs.summary.json"
    pairs_path = out_dir / "dpo-pairs.jsonl"
    pairs_path.write_text("".join(json.dumps(pair, separators=(",", ":")) + "\n" for pair in pairs))
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"pairs": str(pairs_path), "summary": str(summary_path), **summary}, indent=2))


if __name__ == "__main__":
    main()
