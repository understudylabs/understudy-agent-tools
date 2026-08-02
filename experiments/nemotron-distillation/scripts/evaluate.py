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
from env_client import close_service, get_service
from events import emit_event
from models import MODEL_SPECS, get_model_spec
from receipts import snapshot_usage_async, write_receipt
from rollout import RolloutConfig, rollout_task
from step_runtime import record_completed, replay_or_start, synchronous_job_ref
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

DEFAULT_SERVICE_REPO = "/home/ubuntu/wt-402"


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", choices=("train", "dev", "holdout"), required=True)
    parser.add_argument("--model", required=True, choices=tuple(MODEL_SPECS))
    parser.add_argument("--adapter-path", help="override the model registry adapter path")
    parser.add_argument("--service-repo", default=DEFAULT_SERVICE_REPO)
    parser.add_argument("--label", default="eval")
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--out", required=True)
    parser.add_argument("--frozen-holdout-sha256")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--one-per-band", action="store_true")
    parser.add_argument("--passes", type=int, default=1)
    parser.add_argument("--warmup-rollouts", type=int, default=0)
    parser.add_argument("--experiment-id", default="P3-nemotron-distillation")
    parser.add_argument("--candidate-id")
    parser.add_argument("--attempt", type=int, default=1)
    return parser.parse_args()


def _family_stats(records: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    by_band: dict[str, list[float]] = {}
    for record in records:
        by_band.setdefault(record["band"], []).append(record["reward"])
    return {
        band: {"count": len(values), "mean_reward": statistics.fmean(values)}
        for band, values in sorted(by_band.items())
    }


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
    if args.samples < 1:
        raise SystemExit("--samples must be positive")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be positive")
    if args.passes < 1 or args.warmup_rollouts < 0:
        raise SystemExit("--passes must be positive and warmup-rollouts non-negative")
    if args.split == "holdout":
        raise SystemExit(
            "evaluate.py refuses --split holdout; use sealed_holdout.py for one paired pass"
        )
    candidate_id = args.candidate_id or args.model
    key, replay = replay_or_start(args.experiment_id, candidate_id, args.attempt)
    if replay is not None:
        print(json.dumps(replay, indent=2))
        return replay

    spec = get_model_spec(args.model, args.adapter_path)
    service = get_service(args.service_repo)
    hashes = service.hashes()
    tasks = service.tasks(args.split, args.frozen_holdout_sha256)
    if args.one_per_band:
        tasks = [next(task for task in tasks if task["band"] == band) for band in ("single-write", "discovery", "multi-write")]
    if args.limit is not None:
        tasks = tasks[: args.limit]

    renderer = renderers.get_renderer(
        spec.renderer_name,
        get_tokenizer(spec.base_model),
        model_name=spec.base_model,
    )
    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    receipt_path = Path(args.out).with_suffix(".usage.json")
    usage_before = await snapshot_usage_async(rest_client)
    client_started = time.perf_counter()
    if spec.model_path is None:
        sampling_client = await service_client.create_sampling_client_async(base_model=spec.base_model)
    else:
        sampling_client = await service_client.create_sampling_client_async(model_path=spec.model_path)
    client_creation_seconds = time.perf_counter() - client_started
    emit_event(
        "candidate",
        "submitted",
        experiment_id=args.experiment_id,
        candidate_id=candidate_id,
        attempt=args.attempt,
        model=args.model,
        client_creation_seconds=client_creation_seconds,
    )

    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(task: dict[str, Any], sample_index: int) -> dict[str, Any]:
        async with semaphore:
            result = await rollout_task(
                service,
                sampling_client,
                renderer,
                task,
                RolloutConfig(
                    temperature=args.temperature if args.temperature is not None else spec.temperature,
                    frozen_holdout_sha256=args.frozen_holdout_sha256,
                    prompt_variant=spec.prompt_variant,
                ),
                spec,
            )
            result["sample_index"] = sample_index
            return result

    warmup_records: list[dict[str, Any]] = []
    for warmup_index in range(args.warmup_rollouts):
        warmup_task = tasks[warmup_index % len(tasks)]
        warmup_records.append(await one(warmup_task, warmup_index))
    records: list[dict[str, Any]] = []
    pass_records: list[list[dict[str, Any]]] = []
    for pass_index in range(args.passes):
        jobs = [
            asyncio.create_task(one(task, sample_index))
            for task in tasks
            for sample_index in range(args.samples)
        ]
        current = await asyncio.gather(*jobs)
        for record in current:
            record["pass_index"] = pass_index + 1
        pass_records.append(current)
        records.extend(current)

    model_label = spec.name
    split_sha = hashes["split_sha256"][args.split]
    rows = []
    for record in records:
        rows.append(
            {
                "schema_version": "understudy.eval_result.v1",
                "run_id": args.label,
                "task_id": record["task_id"],
                "split": record["split"],
                "score": record["reward"],
                "status": "ok",
                "model": model_label,
                "base_model": spec.base_model,
                "adapter_path": spec.model_path,
                "route": "tinker",
                "cost": {"usd": None, "basis": "tinker_billing_usage"},
                "benchmark_id": "automationbench-simple-api-offline",
                "subscores": {
                    "forbidden_effects": len(record["forbidden_effects"]),
                    "steps": record["env_steps"],
                },
                "provenance": {
                    "harness_sha256": hashes["fixture_sha256"],
                    "split_sha256": split_sha,
                    "artifact_refs": ["fixture://automationbench-simple-api-offline-v1"],
                },
                "family": record["family"],
                "band": record["band"],
                "sample_index": record["sample_index"],
                "pass_index": record["pass_index"],
                "model_turns": record["model_turns"],
                "env_steps": record["env_steps"],
                "forbidden_effects": record["forbidden_effects"],
                "parse_errors": record["parse_errors"],
                "finished_explicitly": record["finished_explicitly"],
                "messages": record["messages"],
                "sampled_token_counts": record["sampled_token_counts"],
                "prompt_token_counts": record["prompt_token_counts"],
                "sampling_latencies_seconds": record["sampling_latencies_seconds"],
                "sampling_latency_seconds_total": record["sampling_latency_seconds_total"],
                "latency_ms": record["sampling_latency_seconds_total"] * 1000,
                "serving_contract": record["serving_contract"],
                "action_parser_id": record["action_parser_id"],
            }
        )

    summary = {
        "label": args.label,
        "split": args.split,
        "model": spec.name,
        "model_path": spec.model_path,
        "base_model": spec.base_model,
        "renderer": spec.renderer_name,
        "prompt_variant": spec.prompt_variant,
        "lora_rank": spec.lora_rank,
        "serving_contract": spec.serving_contract(
            temperature=args.temperature,
            stop_sequences=list(renderer.get_stop_sequences()),
        ),
        "temperature": args.temperature,
        "samples_per_task": args.samples,
        "passes": args.passes,
        "warmup_rollouts": args.warmup_rollouts,
        "client_creation_seconds": client_creation_seconds,
        "warmup_latency_seconds": [
            record["sampling_latency_seconds_total"] for record in warmup_records
        ],
        "task_count": len(tasks),
        "row_count": len(rows),
        "mean_reward": statistics.fmean(record["reward"] for record in records) if records else 0.0,
        "strict_pass_rate": (
            sum(record["reward"] == 1.0 for record in records) / len(records) if records else 0.0
        ),
        "per_band": _family_stats(records),
        "mean_model_turns": statistics.fmean(record["model_turns"] for record in records) if records else 0.0,
        "mean_per_turn_sampling_latency_seconds": (
            statistics.fmean(latency for record in records for latency in record["sampling_latencies_seconds"])
            if records and any(record["sampling_latencies_seconds"] for record in records) else 0.0
        ),
        "p50_per_turn_sampling_latency_seconds": (
            statistics.median(latency for record in records for latency in record["sampling_latencies_seconds"])
            if records and any(record["sampling_latencies_seconds"] for record in records) else 0.0
        ),
        "mean_per_task_sampling_latency_seconds": (
            statistics.fmean(record["sampling_latency_seconds_total"] for record in records) if records else 0.0
        ),
        "mean_prompt_plus_sampled_tokens": (
            statistics.fmean(
                sum(record["prompt_token_counts"]) + sum(record["sampled_token_counts"])
                for record in records
            ) if records else 0.0
        ),
        "parse_error_rate": (
            sum(bool(record["parse_errors"]) for record in records) / len(records) if records else 0.0
        ),
        "total_sampled_tokens": sum(sum(record["sampled_token_counts"]) for record in records),
        "total_prompt_tokens": sum(sum(record["prompt_token_counts"]) for record in records),
        "groups": _group_stats(records),
        "hashes": hashes,
    }
    all_turn_latencies = [
        latency
        for record in records
        for latency in record["sampling_latencies_seconds"]
    ]
    summary["per_turn_latency_distribution_seconds"] = {
        "count": len(all_turn_latencies),
        "mean": statistics.fmean(all_turn_latencies) if all_turn_latencies else 0.0,
        "p50": statistics.median(all_turn_latencies) if all_turn_latencies else 0.0,
        "p90": (
            statistics.quantiles(all_turn_latencies, n=10, method="inclusive")[8]
            if len(all_turn_latencies) > 1
            else (all_turn_latencies[0] if all_turn_latencies else 0.0)
        ),
    }
    summary["per_pass"] = [
        {
            "pass_index": index + 1,
            "mean_reward": statistics.fmean(row["reward"] for row in current),
            "strict_pass_rate": sum(row["reward"] == 1.0 for row in current)
            / len(current),
            "mean_per_task_sampling_latency_seconds": statistics.fmean(
                row["sampling_latency_seconds_total"] for row in current
            ),
        }
        for index, current in enumerate(pass_records)
    ]
    by_task_pass_rewards: dict[str, list[float]] = {}
    for record in records:
        by_task_pass_rewards.setdefault(record["task_id"], []).append(record["reward"])
    summary["reward_nondeterminism"] = {
        "observed": any(len(set(rewards)) > 1 for rewards in by_task_pass_rewards.values()),
        "tasks_with_multiple_rewards": {
            task_id: rewards
            for task_id, rewards in by_task_pass_rewards.items()
            if len(set(rewards)) > 1
        },
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    summary_path = output.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    usage_after = await snapshot_usage_async(rest_client)
    write_receipt(rest_client, receipt_path, args.label, usage_before, usage_after)
    result = {
        "out": str(output),
        "summary": str(summary_path),
        "rows": len(rows),
        "job_ref": synchronous_job_ref(key),
    }
    record_completed(key, args.experiment_id, candidate_id, args.attempt, result)
    for record in records:
        emit_event(
            "rollout",
            "terminal",
            experiment_id=args.experiment_id,
            candidate_id=candidate_id,
            attempt=args.attempt,
            task_id=record["task_id"],
            split=record["split"],
            pass_index=record["pass_index"],
            reward=record["reward"],
            model_turns=record["model_turns"],
            parse_error_count=len(record["parse_errors"]),
        )
    emit_event(
        "score",
        "snapshot",
        experiment_id=args.experiment_id,
        candidate_id=candidate_id,
        attempt=args.attempt,
        split=args.split,
        mean_reward=summary["mean_reward"],
        passes=args.passes,
        row_count=len(rows),
    )
    emit_event(
        "usage",
        "reconciled",
        experiment_id=args.experiment_id,
        candidate_id=candidate_id,
        attempt=args.attempt,
        prompt_tokens=summary["total_prompt_tokens"],
        sampled_tokens=summary["total_sampled_tokens"],
        cost_usd=None,
    )
    print(json.dumps(result, indent=2))
    return summary


def main() -> None:
    args = _args()
    try:
        asyncio.run(_run(args))
    finally:
        close_service()


if __name__ == "__main__":
    main()
