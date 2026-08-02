"""Generate verifier-accepted, train-only teacher trajectories for distillation."""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path
from typing import Any

import tinker
from env_client import close_service, get_service
from events import emit_event
from models import get_model_spec
from receipts import snapshot_usage_async, write_receipt
from rollout import RolloutConfig, parse_agent_action, rollout_task
from step_runtime import record_completed, replay_or_start, synchronous_job_ref
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

DEFAULT_SERVICE_REPO = "/home/ubuntu/wt-402"
EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
DEFAULT_OUT = ARTIFACT_DIR / "teacher-trajectories.jsonl"


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-repo", default=DEFAULT_SERVICE_REPO)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--k", type=int, default=4)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--experiment-id", default="P3-nemotron-distillation")
    parser.add_argument("--candidate-id", default="teacher-trajectories")
    parser.add_argument("--attempt", type=int, default=1)
    return parser.parse_args()


def _action_sequence(messages: list[dict[str, Any]]) -> str:
    actions = []
    for message in messages:
        if message.get("role") != "assistant":
            continue
        action = parse_agent_action(str(message.get("content", "")))
        if "error" in action:
            actions.append({"error": action["error"]})
        elif action.get("finish"):
            actions.append({"tool": "finish", "arguments": {}})
        else:
            actions.append({"tool": action["name"], "arguments": action["arguments"]})
    return json.dumps(actions, sort_keys=True, separators=(",", ":"))


def _task_summary(candidates: list[dict[str, Any]], kept: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "task_id": candidates[0]["task_id"],
        "band": candidates[0]["band"],
        "candidate_count": len(candidates),
        "accepted_count": len(kept),
        "accept_rate": len(kept) / len(candidates) if candidates else 0.0,
        "zero_accepted": not kept,
        "candidate_rewards": [candidate["reward"] for candidate in candidates],
    }


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    if args.k < 1:
        raise SystemExit("--k must be positive")
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    key, replay = replay_or_start(args.experiment_id, args.candidate_id, args.attempt)
    if replay is not None:
        print(json.dumps(replay, indent=2))
        return replay

    started = time.perf_counter()
    service = get_service(args.service_repo)
    tasks = service.tasks("train")
    if any(task["split"] != "train" for task in tasks):
        raise RuntimeError("teacher trajectory loader refused a non-train task")
    if len(tasks) != 48:
        raise RuntimeError(f"expected 48 train tasks, got {len(tasks)}")

    spec = get_model_spec("teacher")
    tokenizer = get_tokenizer(spec.base_model)
    renderer = renderers.get_renderer(
        spec.renderer_name,
        tokenizer,
        model_name=spec.base_model,
    )
    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    usage_before = await snapshot_usage_async(rest_client)
    emit_event(
        "run",
        "phase_started",
        experiment_id=args.experiment_id,
        candidate_id=args.candidate_id,
        attempt=args.attempt,
        phase="teacher-trajectories",
        split="train",
    )
    sampling_client = await service_client.create_sampling_client_async(model_path=spec.model_path)
    semaphore = asyncio.Semaphore(args.concurrency)

    async def sample(task: dict[str, Any], temperature: float, index: int) -> dict[str, Any]:
        async with semaphore:
            result = await rollout_task(
                service,
                sampling_client,
                renderer,
                task,
                RolloutConfig(
                    temperature=temperature,
                    prompt_variant=spec.prompt_variant,
                ),
                spec,
            )
            result["candidate_index"] = index
            result["candidate_temperature"] = temperature
            return result

    jobs = [
        asyncio.create_task(sample(task, 1.0, index))
        for task in tasks
        for index in range(args.k)
    ]
    jobs.extend(
        asyncio.create_task(sample(task, 0.0, args.k))
        for task in tasks
    )
    candidates = await asyncio.gather(*jobs)
    by_task: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        by_task.setdefault(candidate["task_id"], []).append(candidate)

    kept: list[dict[str, Any]] = []
    task_summaries = []
    for task in tasks:
        task_candidates = by_task[task["task_id"]]
        accepted: list[dict[str, Any]] = []
        seen: set[str] = set()
        for candidate in task_candidates:
            if candidate["split"] != "train":
                raise RuntimeError("teacher trajectory candidate escaped train split")
            if candidate["reward"] != 1.0:
                continue
            sequence = _action_sequence(candidate["messages"])
            if sequence in seen:
                continue
            seen.add(sequence)
            accepted.append(candidate)
            if len(accepted) == 4:
                break
        task_summaries.append(_task_summary(task_candidates, accepted))
        for candidate in accepted:
            kept.append(
                {
                    "schema_version": "understudy.distillation_trajectory.v1",
                    "task_id": candidate["task_id"],
                    "split": candidate["split"],
                    "family": candidate["family"],
                    "band": candidate["band"],
                    "reward": candidate["reward"],
                    "messages": candidate["messages"],
                    "model_turns": candidate["model_turns"],
                    "env_steps": candidate["env_steps"],
                    "parse_errors": candidate["parse_errors"],
                    "sampled_token_counts": candidate["sampled_token_counts"],
                    "prompt_token_counts": candidate["prompt_token_counts"],
                    "sampling_latencies_seconds": candidate["sampling_latencies_seconds"],
                    "sampling_latency_seconds_total": candidate["sampling_latency_seconds_total"],
                    "candidate_index": candidate["candidate_index"],
                    "candidate_temperature": candidate["candidate_temperature"],
                    "serving_contract": candidate["serving_contract"],
                    "action_parser_id": candidate["action_parser_id"],
                    "verifier_checked": True,
                }
            )

    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in kept),
        encoding="utf-8",
    )
    usage_after = await snapshot_usage_async(rest_client)
    receipt_path = output.with_suffix(".usage.json")
    write_receipt(rest_client, receipt_path, "teacher-trajectories", usage_before, usage_after)

    by_band: dict[str, list[dict[str, Any]]] = {}
    for task_summary in task_summaries:
        by_band.setdefault(task_summary["band"], []).append(task_summary)
    band_summary = {
        band: {
            "task_count": len(rows),
            "candidate_count": sum(row["candidate_count"] for row in rows),
            "accepted_count": sum(row["accepted_count"] for row in rows),
            "accept_rate": (
                sum(row["accepted_count"] for row in rows)
                / sum(row["candidate_count"] for row in rows)
            ),
            "zero_accepted_tasks": [row["task_id"] for row in rows if row["zero_accepted"]],
        }
        for band, rows in sorted(by_band.items())
    }
    summary = {
        "schema_version": "understudy.distillation_trajectory_summary.v1",
        "source_split": "train",
        "task_count": len(tasks),
        "candidates_per_task": args.k + 1,
        "candidate_count": len(candidates),
        "kept_count": len(kept),
        "cap_per_task": 4,
        "accept_rate": len(kept) / len(candidates) if candidates else 0.0,
        "tasks_with_zero_accepted": [
            row["task_id"] for row in task_summaries if row["zero_accepted"]
        ],
        "per_band": band_summary,
        "per_task": task_summaries,
        "total_prompt_tokens": sum(sum(row["prompt_token_counts"]) for row in kept),
        "total_sampled_tokens": sum(sum(row["sampled_token_counts"]) for row in kept),
        "total_sampling_latency_seconds": sum(
            row["sampling_latency_seconds_total"] for row in kept
        ),
        "wall_clock_seconds": time.perf_counter() - started,
        "serving_contract": spec.serving_contract(
            temperature=1.0,
            stop_sequences=list(renderer.get_stop_sequences()),
        ),
        "receipt": str(receipt_path),
        "holdout_accessed": False,
    }
    summary_path = output.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"out": str(output), "summary": str(summary_path), "kept": len(kept)}))
    result = {
        "out": str(output),
        "summary": str(summary_path),
        "kept": len(kept),
        "job_ref": synchronous_job_ref(key),
    }
    record_completed(key, args.experiment_id, args.candidate_id, args.attempt, result)
    for candidate in candidates:
        emit_event(
            "rollout",
            "terminal",
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            task_id=candidate["task_id"],
            split=candidate["split"],
            reward=candidate["reward"],
            model_turns=candidate["model_turns"],
            parse_error_count=len(candidate["parse_errors"]),
        )
    emit_event(
        "score",
        "snapshot",
        experiment_id=args.experiment_id,
        candidate_id=args.candidate_id,
        attempt=args.attempt,
        split="train",
        accepted_count=len(kept),
        candidate_count=len(candidates),
        zero_accepted_count=len(summary["tasks_with_zero_accepted"]),
    )
    emit_event(
        "usage",
        "reconciled",
        experiment_id=args.experiment_id,
        candidate_id=args.candidate_id,
        attempt=args.attempt,
        prompt_tokens=summary["total_prompt_tokens"],
        sampled_tokens=summary["total_sampled_tokens"],
        cost_usd=None,
    )
    return summary


def main() -> None:
    args = _args()
    try:
        asyncio.run(_run(args))
    finally:
        close_service()


if __name__ == "__main__":
    main()
