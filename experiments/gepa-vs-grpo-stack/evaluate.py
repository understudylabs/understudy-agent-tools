"""CLI for baseline and variance evaluation through the AutomationBench service."""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
from pathlib import Path
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import close_service, get_service
from receipts import snapshot_usage_async, write_receipt
from rollout import (
    LORA_RANK,
    MODEL_NAME,
    RENDERER_DEVIATION,
    RENDERER_NAME,
    RolloutConfig,
    rollout_task,
)

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
USAGE_RECEIPT_TIMEOUT_SECONDS = 30


def _enable_system_certificates_for_tinker() -> None:
    """Use the box's system CA bundle with Tinker's pyqwest transport."""
    import pyqwest
    import tinker._base_client as tinker_base
    from pyqwest.httpx import AsyncPyqwestTransport

    tinker_base._default_pyqwest_transport = lambda: AsyncPyqwestTransport(
        transport=pyqwest.HTTPTransport(tls_include_system_certs=True)
    )


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
    parser.add_argument("--max-model-turns", type=int, default=12)
    parser.add_argument(
        "--system-prompt-file",
        type=Path,
        help="Append a GEPA system-prompt suffix to the baseline protocol prompt.",
    )
    parser.add_argument(
        "--no-usage-receipt",
        action="store_true",
        help="Skip the optional Tinker billing-usage receipt request.",
    )
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


async def _safe_usage_snapshot(rest_client: Any) -> tuple[dict[str, Any] | None, str | None]:
    try:
        return await asyncio.wait_for(
            snapshot_usage_async(rest_client),
            timeout=USAGE_RECEIPT_TIMEOUT_SECONDS,
        ), None
    except Exception as error:
        return None, f"{type(error).__name__}: {error}"


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    if args.samples < 1:
        raise SystemExit("--samples must be positive")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be positive")
    if args.max_model_turns < 1:
        raise SystemExit("--max-model-turns must be positive")
    if args.split == "holdout" and not args.frozen_holdout_sha256:
        raise SystemExit("--frozen-holdout-sha256 is required for --split holdout")
    system_prompt_suffix = None
    if args.system_prompt_file:
        system_prompt_suffix = args.system_prompt_file.read_text(encoding="utf-8").strip()
        if not system_prompt_suffix:
            raise SystemExit("--system-prompt-file must contain a non-empty prompt suffix")

    _enable_system_certificates_for_tinker()
    service = get_service(str(REPO))
    hashes = service.hashes()
    tasks = service.tasks(args.split, args.frozen_holdout_sha256)
    if args.limit is not None:
        tasks = tasks[: args.limit]

    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    receipt_path = Path(args.out).with_suffix(".usage.json")
    usage_before = None
    usage_error = None
    if not args.no_usage_receipt:
        usage_before, usage_error = await _safe_usage_snapshot(rest_client)
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
                    system_prompt_suffix=system_prompt_suffix,
                    max_model_turns=args.max_model_turns,
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
                "model_turns": record["model_turns"],
                "env_steps": record["env_steps"],
                "forbidden_effects": record["forbidden_effects"],
                "parse_errors": record["parse_errors"],
                "finished_explicitly": record["finished_explicitly"],
                "messages": record["messages"],
                "sampled_token_counts": record["sampled_token_counts"],
                "prompt_token_counts": record["prompt_token_counts"],
            }
        )

    summary = {
        "label": args.label,
        "split": args.split,
        "model_path": args.model_path,
        "system_prompt_file": str(args.system_prompt_file) if args.system_prompt_file else None,
        "model": model_label,
        "renderer": RENDERER_NAME,
        "renderer_deviation": RENDERER_DEVIATION,
        "lora_rank": LORA_RANK,
        "temperature": args.temperature,
        "samples_per_task": args.samples,
        "task_count": len(tasks),
        "row_count": len(rows),
        "mean_reward": statistics.fmean(record["reward"] for record in records) if records else 0.0,
        "strict_pass_rate": (
            sum(record["reward"] == 1.0 for record in records) / len(records) if records else 0.0
        ),
        "per_band": _family_stats(records),
        "mean_model_turns": statistics.fmean(record["model_turns"] for record in records) if records else 0.0,
        "parse_error_rate": (
            sum(bool(record["parse_errors"]) for record in records) / len(records) if records else 0.0
        ),
        "total_sampled_tokens": sum(sum(record["sampled_token_counts"]) for record in records),
        "total_prompt_tokens": sum(sum(record["prompt_token_counts"]) for record in records),
        "groups": _group_stats(records),
        "hashes": hashes,
    }
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    summary_path = output.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    if usage_before is not None:
        usage_after, usage_error = await _safe_usage_snapshot(rest_client)
        if usage_after is not None:
            write_receipt(rest_client, receipt_path, args.label, usage_before, usage_after)
        else:
            receipt_path.write_text(
                json.dumps(
                    {
                        "phase": args.label,
                        "status": "unavailable",
                        "error": usage_error,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
    elif not args.no_usage_receipt:
        receipt_path.write_text(
            json.dumps(
                {
                    "phase": args.label,
                    "status": "unavailable",
                    "error": usage_error,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
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
