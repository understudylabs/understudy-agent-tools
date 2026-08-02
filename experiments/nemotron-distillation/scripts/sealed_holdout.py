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
from events import emit_event
from models import MODEL_SPECS, get_model_spec
from receipts import snapshot_usage_async, write_receipt
from rollout import RolloutConfig, rollout_task
from step_runtime import record_completed, replay_or_start, synchronous_job_ref
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
    parser.add_argument("--experiment-id", default="P3-nemotron-distillation")
    parser.add_argument("--candidate-id", default="sealed-holdout")
    parser.add_argument("--attempt", type=int, default=1)
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


def _verdict(
    all_rows: dict[str, list[dict[str, Any]]], tolerance: dict[str, Any]
) -> dict[str, Any]:
    quality = tolerance["quality_tolerance"]
    guardrails = tolerance["guardrails"]
    teacher_rows = all_rows["teacher"]
    student_rows = all_rows["student-sft"]
    teacher_mean = statistics.fmean(row["reward"] for row in teacher_rows)
    student_mean = statistics.fmean(row["reward"] for row in student_rows)
    per_band_deficit = {}
    for band in ("single-write", "discovery", "multi-write"):
        teacher_band = statistics.fmean(
            row["reward"] for row in teacher_rows if row["band"] == band
        )
        student_band = statistics.fmean(
            row["reward"] for row in student_rows if row["band"] == band
        )
        per_band_deficit[band] = teacher_band - student_band
    hard_fail_count = sum(
        student["reward"] == 0.0 and teacher["reward"] > student["reward"]
        for teacher, student in zip(teacher_rows, student_rows, strict=True)
    )
    parse_error_rate = sum(bool(row["parse_errors"]) for row in student_rows) / len(
        student_rows
    )
    checks = {
        "overall_mean_reward_deficit": {
            "observed": teacher_mean - student_mean,
            "max": quality["overall_mean_reward_deficit_max"],
            "pass": teacher_mean - student_mean
            <= quality["overall_mean_reward_deficit_max"],
        },
        "per_band_mean_reward_deficit": {
            "observed": per_band_deficit,
            "max": quality["per_band_mean_reward_deficit_max"],
            "pass": all(
                deficit <= quality["per_band_mean_reward_deficit_max"]
                for deficit in per_band_deficit.values()
            ),
        },
        "primary_band_mean_reward_deficit": {
            "band": quality["primary_band"],
            "observed": per_band_deficit[quality["primary_band"]],
            "max": quality["per_band_mean_reward_deficit_max"],
            "pass": per_band_deficit[quality["primary_band"]]
            <= quality["per_band_mean_reward_deficit_max"],
        },
        "student_hard_fail_count_over_teacher": {
            "observed": hard_fail_count,
            "max": guardrails["student_hard_fail_count_max_over_teacher"],
            "pass": hard_fail_count
            <= guardrails["student_hard_fail_count_max_over_teacher"],
        },
        "student_parse_error_rate": {
            "observed": parse_error_rate,
            "max": guardrails["student_parse_error_rate_max"],
            "pass": parse_error_rate <= guardrails["student_parse_error_rate_max"],
        },
    }
    return {
        "verdict": "PASS" if all(check["pass"] for check in checks.values()) else "FAIL",
        "checks": checks,
        "rule": tolerance["verdict_rule"],
        "efficiency_claim_rule": tolerance["efficiency_claim_rule"],
    }


async def _run(args: argparse.Namespace) -> None:
    if args.concurrency < 1 or args.concurrency > 8:
        raise SystemExit("--concurrency must be between 1 and 8")
    key, replay = replay_or_start(args.experiment_id, args.candidate_id, args.attempt)
    if replay is not None:
        print(json.dumps(replay, indent=2))
        return
    if len(set(args.models)) != len(args.models):
        raise SystemExit("--models must not contain duplicates")
    unknown = sorted(set(args.models) - set(MODEL_SPECS))
    if unknown:
        raise SystemExit(f"unknown model specs: {unknown}")
    tolerance_file = Path(args.tolerance_file).resolve()
    if not tolerance_file.is_file():
        raise SystemExit(f"tolerance file does not exist: {tolerance_file}")
    tolerance_sha256 = _sha256(tolerance_file)
    tolerance = json.loads(tolerance_file.read_text())
    declared_models = tolerance.get("declared_models")
    if declared_models is not None and args.models != declared_models:
        raise SystemExit("declared model list must match the predeclared tolerance file")
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
        emit_event(
            "run",
            "phase_started",
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            phase="sealed-holdout",
        )
        tasks = service.tasks("holdout", HOLDOUT_SHA256)
        if len(tasks) != 12:
            raise RuntimeError(f"expected 12 holdout tasks, got {len(tasks)}")
        semaphore = asyncio.Semaphore(args.concurrency)
        all_rows: dict[str, list[dict[str, Any]]] = {}
        receipts: dict[str, str] = {}
        for model_name in args.models:
            if model_name == "student-sft":
                selection = json.loads(
                    (ARTIFACT_DIR / "selection.json").read_text()
                )
                spec = get_model_spec(
                    model_name, selection["selected_adapter_path"]
                )
            else:
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
        verdict = _verdict(all_rows, tolerance)
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
                    "verdict": verdict,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        result = {
            "out": str(output),
            "models": args.models,
            "verdict": verdict,
            "job_ref": synchronous_job_ref(key),
        }
        record_completed(key, args.experiment_id, args.candidate_id, args.attempt, result)
        emit_event(
            "score",
            "snapshot",
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            phase="sealed-holdout",
            verdict=verdict["verdict"],
        )
        print(json.dumps(result))
    finally:
        close_service()


def main() -> None:
    asyncio.run(_run(_args()))


if __name__ == "__main__":
    main()
