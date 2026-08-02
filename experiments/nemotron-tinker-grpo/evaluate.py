"""CLI for baseline and variance evaluation through the AutomationBench service."""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from pathlib import Path
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import close_service, get_service
from receipts import snapshot_usage_async, write_receipt
from tinker_client import create_service_client
from rollout import (
    LORA_RANK,
    MODEL_NAME,
    RENDERER_DEVIATION,
    RENDERER_NAME,
    MAX_MODEL_TURNS,
    RolloutConfig,
    rollout_task,
)

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
TINKER_PREFILL_USD_PER_MILLION = 0.39
TINKER_SAMPLE_USD_PER_MILLION = 0.99
TINKER_DISCOUNTED_PREFILL_USD_PER_MILLION = 0.195
TINKER_DISCOUNTED_SAMPLE_USD_PER_MILLION = 0.495


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", choices=("train", "dev", "holdout"), required=True)
    parser.add_argument("--model-path", required=True, help="base or a saved tinker:// model path")
    parser.add_argument("--label", default="eval")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--out", required=True)
    parser.add_argument("--frozen-holdout-sha256")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--benchmark", choices=("automationbench", "automationbench-v2"), default="automationbench")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--task-ids", help="comma-separated task ids to evaluate instead of the first --limit tasks")
    return parser.parse_args()


def _family_stats(records: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    by_band: dict[str, list[float]] = {}
    for record in records:
        by_band.setdefault(record["band"], []).append(record["reward"])
    return {
        band: {"count": len(values), "mean_reward": statistics.fmean(values)}
        for band, values in sorted(by_band.items())
    }


def _tier_stats(records: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    tiers: dict[str, list[float]] = {"v1-style": [], "hard": []}
    for record in records:
        tier = "hard" if record["task_id"].startswith("hard-api-") else "v1-style"
        tiers[tier].append(record["reward"])
    return {
        tier: {"count": len(values), "mean_reward": statistics.fmean(values)}
        for tier, values in tiers.items()
        if values
    }


def _termination_failures(records: list[dict[str, Any]]) -> dict[str, int]:
    failures = {
        "step_limit_exhaustion": 0,
        "no_parsed_call": 0,
        "never_terminating": 0,
    }
    for record in records:
        if record["finished_explicitly"]:
            continue
        if record["model_turns"] >= MAX_MODEL_TURNS:
            failures["step_limit_exhaustion"] += 1
        elif not record["env_steps"] and record["parse_errors"]:
            failures["no_parsed_call"] += 1
        else:
            failures["never_terminating"] += 1
    return failures


def _group_stats(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[float]] = {}
    for record in records:
        grouped.setdefault(record["task_id"], []).append(record["reward"])
    result = []
    for task_id, rewards in grouped.items():
        result.append(
            {
                "task_id": task_id,
                "samples": len(rewards),
                "reward_mean": statistics.fmean(rewards),
                "reward_std": statistics.pstdev(rewards) if len(rewards) > 1 else 0.0,
            }
        )
    return sorted(result, key=lambda row: row["task_id"])


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    if args.samples < 1:
        raise SystemExit("--samples must be positive")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be positive")
    if args.split == "holdout" and not args.frozen_holdout_sha256:
        raise SystemExit("--frozen-holdout-sha256 is required for --split holdout")

    service = get_service(str(REPO), benchmark=args.benchmark)
    hashes = service.hashes()
    tasks = service.tasks(args.split, args.frozen_holdout_sha256)
    if args.task_ids:
        requested = [task_id.strip() for task_id in args.task_ids.split(",") if task_id.strip()]
        by_id = {task["task_id"]: task for task in tasks}
        missing = [task_id for task_id in requested if task_id not in by_id]
        if missing:
            raise SystemExit(f"unknown task ids in {args.split}: {', '.join(missing)}")
        tasks = [by_id[task_id] for task_id in requested]
    if args.limit is not None:
        tasks = tasks[: args.limit]

    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
    system_prompt = args.prompt_file.read_text(encoding="utf-8") if args.prompt_file else None
    service_client = create_service_client()
    rest_client = service_client.create_rest_client()
    receipt_path = Path(args.out).with_suffix(".usage.json")
    usage_before = await snapshot_usage_async(rest_client)
    if args.model_path == "base":
        sampling_client = await service_client.create_sampling_client_async(base_model=MODEL_NAME)
    else:
        sampling_client = await service_client.create_sampling_client_async(model_path=args.model_path)

    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(task: dict[str, Any], sample_index: int) -> dict[str, Any]:
        async with semaphore:
            result = await rollout_task(
                service,
                sampling_client,
                renderer,
                task,
                RolloutConfig(
                    temperature=args.temperature,
                    frozen_holdout_sha256=args.frozen_holdout_sha256,
                    system_prompt=system_prompt,
                ),
            )
            result["sample_index"] = sample_index
            return result

    jobs = [
        asyncio.create_task(one(task, sample_index))
        for task in tasks
        for sample_index in range(args.samples)
    ]
    records = await asyncio.gather(*jobs)

    model_label = MODEL_NAME if args.model_path == "base" else args.model_path
    split_sha = hashes["split_sha256"][args.split]
    rows = []
    encoding_totals: dict[str, int] = {}
    for record in records:
        for encoding, count in record["encoding_counts"].items():
            encoding_totals[encoding] = encoding_totals.get(encoding, 0) + count
        rows.append(
            {
                "schema_version": "understudy.eval_result.v1",
                "run_id": args.label,
                "task_id": record["task_id"],
                "split": record["split"],
                "score": record["reward"],
                "status": "ok",
                "model": model_label,
                "route": "tinker",
                "cost": {"usd": None, "basis": "tinker_billing_usage"},
                "benchmark_id": hashes.get("benchmark_id", "automationbench-simple-api-offline"),
                "subscores": {
                    "forbidden_effects": len(record["forbidden_effects"]),
                    "steps": record["env_steps"],
                },
                "provenance": {
                    "harness_sha256": hashes["fixture_sha256"],
                    "split_sha256": split_sha,
                    "artifact_refs": [
                        f"fixture://{hashes.get('benchmark_id', 'automationbench-simple-api-offline')}"
                    ],
                },
                "family": record["family"],
                "band": record["band"],
                "sample_index": record["sample_index"],
                "model_turns": record["model_turns"],
                "env_steps": record["env_steps"],
                "forbidden_effects": record["forbidden_effects"],
                "parse_errors": record["parse_errors"],
                "finished_explicitly": record["finished_explicitly"],
                "messages": record["messages"],
                "sampled_token_counts": record["sampled_token_counts"],
                "prompt_token_counts": record["prompt_token_counts"],
                "encoding_counts": record["encoding_counts"],
            }
        )

    summary = {
        "label": args.label,
        "split": args.split,
        "model_path": args.model_path,
        "model": model_label,
        "renderer": RENDERER_NAME,
        "renderer_deviation": RENDERER_DEVIATION,
        "lora_rank": LORA_RANK,
        "temperature": args.temperature,
        "max_model_turns": MAX_MODEL_TURNS,
        "samples_per_task": args.samples,
        "task_count": len(tasks),
        "row_count": len(rows),
        "mean_reward": statistics.fmean(record["reward"] for record in records) if records else 0.0,
        "strict_pass_rate": (
            sum(record["reward"] == 1.0 for record in records) / len(records) if records else 0.0
        ),
        "per_band": _family_stats(records),
        "per_difficulty_tier": _tier_stats(records),
        "mean_model_turns": statistics.fmean(record["model_turns"] for record in records) if records else 0.0,
        "parse_error_rate": (
            sum(bool(record["parse_errors"]) for record in records) / len(records) if records else 0.0
        ),
        "total_sampled_tokens": sum(sum(record["sampled_token_counts"]) for record in records),
        "total_prompt_tokens": sum(sum(record["prompt_token_counts"]) for record in records),
        "cost": {
            "pricing_source": "https://tinker-docs.thinkingmachines.ai/tinker/models/",
            "prompt_usd_per_million": TINKER_PREFILL_USD_PER_MILLION,
            "sample_usd_per_million": TINKER_SAMPLE_USD_PER_MILLION,
            "undiscounted_inference_usd": (
                sum(sum(record["prompt_token_counts"]) for record in records)
                / 1_000_000
                * TINKER_PREFILL_USD_PER_MILLION
                + sum(sum(record["sampled_token_counts"]) for record in records)
                / 1_000_000
                * TINKER_SAMPLE_USD_PER_MILLION
            ),
            "discounted_inference_usd": (
                sum(sum(record["prompt_token_counts"]) for record in records)
                / 1_000_000
                * TINKER_DISCOUNTED_PREFILL_USD_PER_MILLION
                + sum(sum(record["sampled_token_counts"]) for record in records)
                / 1_000_000
                * TINKER_DISCOUNTED_SAMPLE_USD_PER_MILLION
            ),
        },
        "groups": _group_stats(records),
        "hashes": hashes,
        "wall_time_seconds": time.perf_counter() - started,
        "encoding_counts": encoding_totals,
        "termination_failures": _termination_failures(records),
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    summary_path = output.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    usage_after = await snapshot_usage_async(rest_client)
    write_receipt(rest_client, receipt_path, args.label, usage_before, usage_after)
    print(json.dumps({"out": str(output), "summary": str(summary_path), "rows": len(rows)}, indent=2))
    return summary


def main() -> None:
    args = _args()
    try:
        asyncio.run(_run(args))
    finally:
        close_service()


if __name__ == "__main__":
    main()
