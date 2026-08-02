"""Train a rank-32 Qwen SFT adapter on accepted teacher trajectories."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import tinker
from events import emit_event
from models import get_model_spec
from receipts import snapshot_usage, usage_delta
from step_runtime import record_completed, replay_or_start, synchronous_job_ref
from tinker_cookbook import renderers
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised.common import compute_mean_nll
from tinker_cookbook.supervised.data import conversation_to_datum
from tinker_cookbook.tokenizer_utils import get_tokenizer

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
TRAJECTORY_PATH = ARTIFACT_DIR / "teacher-trajectories.jsonl"
MODEL_NAME = "Qwen/Qwen3.5-9B"
RENDERER_NAME = "qwen3_5_disable_thinking"
LORA_RANK = 32
EPOCHS = 4
BATCH_SIZE = 4
LEARNING_RATE = 1e-4
MAX_LENGTH = 4096


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=str(TRAJECTORY_PATH))
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    parser.add_argument("--max-length", type=int, default=MAX_LENGTH)
    parser.add_argument("--experiment-id", default="P3-nemotron-distillation")
    parser.add_argument("--candidate-id", default="student-sft")
    parser.add_argument("--attempt", type=int, default=1)
    return parser.parse_args()


def _load_rows(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows:
        raise RuntimeError(f"no trajectory rows found at {path}")
    if any(row.get("split") != "train" for row in rows):
        raise RuntimeError("SFT loader refuses any non-train trajectory")
    if any(row.get("reward") != 1.0 for row in rows):
        raise RuntimeError("SFT loader refuses unverified teacher trajectories")
    if any(not row.get("verifier_checked") for row in rows):
        raise RuntimeError("SFT loader requires verifier_checked=true")
    return rows


def _masked_token_ids(datum: tinker.Datum) -> list[int]:
    target = datum.loss_fn_inputs["target_tokens"].data
    weights = datum.loss_fn_inputs["weights"].data
    return [
        int(token)
        for token, weight in zip(target, weights, strict=True)
        if float(weight) > 0
    ]


def _checkpoint_details(rest_client: Any, path: str) -> dict[str, Any]:
    parsed = tinker.types.ParsedCheckpointTinkerPath.from_tinker_path(path)
    checkpoints_response = rest_client.list_checkpoints(parsed.training_run_id).result()
    checkpoints = checkpoints_response.checkpoints
    match = next(
        (
            checkpoint
            for checkpoint in checkpoints
            if checkpoint.tinker_path == path
            or checkpoint.checkpoint_id == parsed.checkpoint_id
        ),
        None,
    )
    expiry = None
    if match is not None and match.expires_at is not None:
        expiry = match.expires_at.isoformat().replace("+00:00", "Z")
    return {
        "path": path,
        "training_run_id": parsed.training_run_id,
        "checkpoint_id": parsed.checkpoint_id,
        "checkpoint_type": parsed.checkpoint_type,
        "expires_at": expiry,
    }


def main() -> None:
    args = _args()
    if args.epochs < 1 or args.batch_size < 1 or args.max_length < 1:
        raise SystemExit("epochs, batch-size, and max-length must be positive")
    key, replay = replay_or_start(args.experiment_id, args.candidate_id, args.attempt)
    if replay is not None:
        print(json.dumps(replay, indent=2))
        return
    rows = _load_rows(Path(args.data))
    spec = get_model_spec("student-base")
    tokenizer = get_tokenizer(spec.base_model)
    renderer = renderers.get_renderer(
        RENDERER_NAME,
        tokenizer,
        model_name=MODEL_NAME,
    )
    datums = [
        conversation_to_datum(
            row["messages"],
            renderer,
            max_length=args.max_length,
            train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
        )
        for row in rows
    ]
    if not all(_masked_token_ids(datum) for datum in datums):
        raise RuntimeError("every trajectory must contain assistant target tokens")

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACT_DIR / "sft-data-selection.json").write_text(
        json.dumps(
            {
                "source": str(Path(args.data)),
                "split": "train",
                "row_count": len(rows),
                "dataset_hash": "teacher-trajectories.jsonl",
                "renderer": RENDERER_NAME,
                "lora_rank": LORA_RANK,
                "max_length": args.max_length,
                "total_model_input_tokens": sum(
                    datum.model_input.length for datum in datums
                ),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )

    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    usage_before = snapshot_usage(rest_client)
    training_client = service_client.create_lora_training_client(
        base_model=MODEL_NAME,
        rank=LORA_RANK,
    )
    emit_event(
        "candidate",
        "submitted",
        experiment_id=args.experiment_id,
        candidate_id=args.candidate_id,
        attempt=args.attempt,
        model=MODEL_NAME,
        operation="sft",
    )
    steps_per_epoch = (len(datums) + args.batch_size - 1) // args.batch_size
    total_steps = args.epochs * steps_per_epoch
    checkpoints: list[dict[str, Any]] = []
    step_logs: list[dict[str, Any]] = []
    started = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        for batch_index in range(steps_per_epoch):
            batch = datums[batch_index * args.batch_size : (batch_index + 1) * args.batch_size]
            forward = training_client.forward_backward(
                batch,
                loss_fn="cross_entropy",
            ).result()
            loss = compute_mean_nll(
                [output["logprobs"] for output in forward.loss_fn_outputs],
                [datum.loss_fn_inputs["weights"] for datum in batch],
            )
            global_step = (epoch - 1) * steps_per_epoch + batch_index
            learning_rate = args.learning_rate * (
                1 - global_step / max(total_steps - 1, 1)
            )
            training_client.optim_step(
                tinker.AdamParams(
                    learning_rate=learning_rate,
                    beta1=0.9,
                    beta2=0.95,
                    eps=1e-8,
                )
            ).result()
            step_logs.append(
                {
                    "epoch": epoch,
                    "batch": batch_index + 1,
                    "global_step": global_step + 1,
                    "loss": loss,
                    "learning_rate": learning_rate,
                    "batch_tokens": sum(datum.model_input.length for datum in batch),
                }
            )
        sampler_path = training_client.save_weights_for_sampler(
            name=f"student-sft-epoch{epoch}"
        ).result().path
        checkpoints.append(
            {
                "epoch": epoch,
                "sampler": _checkpoint_details(rest_client, sampler_path),
            }
        )

    state_path = training_client.save_state(name="student-sft-final-state").result().path
    state_details = _checkpoint_details(rest_client, state_path)
    usage_after = snapshot_usage(rest_client)
    (ARTIFACT_DIR / "sft-checkpoints.json").write_text(
        json.dumps(
            {
                "schema_version": "understudy.training_checkpoints.v1",
                "base_model": MODEL_NAME,
                "renderer": RENDERER_NAME,
                "lora_rank": LORA_RANK,
                "epochs": args.epochs,
                "batch_size": args.batch_size,
                "learning_rate": args.learning_rate,
                "max_length": args.max_length,
                "checkpoints": checkpoints,
                "final_state": state_details,
                "created_at": datetime.now().astimezone().isoformat(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    (ARTIFACT_DIR / "sft-training-metrics.json").write_text(
        json.dumps(
            {
                "rows": len(rows),
                "steps_per_epoch": steps_per_epoch,
                "total_steps": total_steps,
                "wall_clock_seconds": time.perf_counter() - started,
                "total_model_input_tokens": sum(
                    datum.model_input.length for datum in datums
                ),
                "step_logs": step_logs,
                "usage_delta": usage_delta(usage_before, usage_after),
                "cost": {"usd": None, "basis": "tinker_billing_usage"},
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    result = {
        "checkpoints": len(checkpoints),
        "state_path": state_path,
        "rows": len(rows),
        "job_ref": synchronous_job_ref(key),
    }
    record_completed(key, args.experiment_id, args.candidate_id, args.attempt, result)
    emit_event(
        "usage",
        "reconciled",
        experiment_id=args.experiment_id,
        candidate_id=args.candidate_id,
        attempt=args.attempt,
        prompt_tokens=0,
        sampled_tokens=0,
        cost_usd=None,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
