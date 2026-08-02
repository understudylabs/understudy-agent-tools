"""Single paired holdout runner; do not invoke until the candidate set is frozen."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import statistics
from pathlib import Path
from typing import Any

import tinker
from env_client import close_service, get_service
from models import MODEL_SPECS, get_model_spec
from receipts import snapshot_usage_async, write_receipt
from rollout import RolloutConfig, rollout_task
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

DEFAULT_SERVICE_REPO = "/home/ubuntu/wt-402"
EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
LOCK_PATH = ARTIFACT_DIR / "holdout-lock.json"
HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701"


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", required=True)
    parser.add_argument("--tolerance-file", required=True)
    parser.add_argument("--service-repo", default=DEFAULT_SERVICE_REPO)
    parser.add_argument("--out", default=str(ARTIFACT_DIR / "sealed-holdout.json"))
    parser.add_argument("--concurrency", type=int, default=8)
    return parser.parse_args()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "row_count": len(rows),
        "mean_reward": statistics.fmean(row["reward"] for row in rows),
        "strict_pass_rate": sum(row["reward"] == 1.0 for row in rows) / len(rows),
        "per_band": {
            band: statistics.fmean(
                row["reward"] for row in rows if row["band"] == band
            )
            for band in sorted({row["band"] for row in rows})
        },
    }


async def _run(args: argparse.Namespace) -> None:
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    if len(set(args.models)) != len(args.models):
        raise SystemExit("--models must not contain duplicates")
    unknown = sorted(set(args.models) - set(MODEL_SPECS))
    if unknown:
        raise SystemExit(f"unknown model specs: {unknown}")
    tolerance_file = Path(args.tolerance_file).resolve()
    if not tolerance_file.is_file():
        raise SystemExit(f"tolerance file does not exist: {tolerance_file}")
    tolerance_sha256 = _sha256(tolerance_file)
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    descriptor = {
        "arm": "P3-nemotron-distillation",
        "split": "holdout",
        "holdout_sha256": HOLDOUT_SHA256,
        "declared_models": args.models,
        "tolerance_file": str(tolerance_file),
        "tolerance_file_sha256": tolerance_sha256,
    }
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError as error:
        raise SystemExit(f"holdout is single-use and already locked: {LOCK_PATH}") from error
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(descriptor, handle, indent=2, sort_keys=True)
        handle.write("\n")

    service = get_service(args.service_repo)
    try:
        tasks = service.tasks("holdout", HOLDOUT_SHA256)
        if len(tasks) != 12:
            raise RuntimeError(f"expected 12 holdout tasks, got {len(tasks)}")
        semaphore = asyncio.Semaphore(args.concurrency)
        all_rows: dict[str, list[dict[str, Any]]] = {}
        receipts: dict[str, str] = {}
        for model_name in args.models:
            spec = get_model_spec(model_name)
            tokenizer = get_tokenizer(spec.base_model)
            renderer = renderers.get_renderer(
                spec.renderer_name,
                tokenizer,
                model_name=spec.base_model,
            )
            client = tinker.ServiceClient()
            rest_client = client.create_rest_client()
            usage_before = await snapshot_usage_async(rest_client)
            if spec.model_path is None:
                sampling_client = await client.create_sampling_client_async(
                    base_model=spec.base_model
                )
            else:
                sampling_client = await client.create_sampling_client_async(
                    model_path=spec.model_path
                )

            async def one(
                task: dict[str, Any],
                sampling_client: Any = sampling_client,
                renderer: Any = renderer,
                spec: Any = spec,
            ) -> dict[str, Any]:
                async with semaphore:
                    return await rollout_task(
                        service,
                        sampling_client,
                        renderer,
                        task,
                        RolloutConfig(
                            temperature=0.0,
                            frozen_holdout_sha256=HOLDOUT_SHA256,
                            prompt_variant=spec.prompt_variant,
                        ),
                        spec,
                    )

            records = await asyncio.gather(*(one(task) for task in tasks))
            rows = [
                {
                    "schema_version": "understudy.eval_result.v1",
                    "run_id": "P3-sealed-holdout",
                    "task_id": record["task_id"],
                    "split": record["split"],
                    "score": record["reward"],
                    "status": "ok",
                    "model": model_name,
                    "band": record["band"],
                    "messages": record["messages"],
                    "parse_errors": record["parse_errors"],
                    "model_turns": record["model_turns"],
                    "sampled_token_counts": record["sampled_token_counts"],
                    "prompt_token_counts": record["prompt_token_counts"],
                    "sampling_latencies_seconds": record["sampling_latencies_seconds"],
                    "latency_ms": record["sampling_latency_seconds_total"] * 1000,
                    "serving_contract": record["serving_contract"],
                    "cost": {"usd": None, "basis": "tinker_billing_usage"},
                }
                for record in records
            ]
            all_rows[model_name] = rows
            receipt_path = ARTIFACT_DIR / f"sealed-holdout-{model_name}.usage.json"
            usage_after = await snapshot_usage_async(rest_client)
            write_receipt(rest_client, receipt_path, model_name, usage_before, usage_after)
            receipts[model_name] = str(receipt_path)

        output = Path(args.out)
        output.write_text(
            json.dumps(
                {
                    "schema_version": "understudy.sealed_holdout.v1",
                    "lock": descriptor,
                    "models": {
                        model: {
                            "summary": _summary(rows),
                            "rows": rows,
                            "receipt": receipts[model],
                        }
                        for model, rows in all_rows.items()
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        print(json.dumps({"out": str(output), "models": args.models}))
    finally:
        close_service()


def main() -> None:
    asyncio.run(_run(_args()))


if __name__ == "__main__":
    main()
