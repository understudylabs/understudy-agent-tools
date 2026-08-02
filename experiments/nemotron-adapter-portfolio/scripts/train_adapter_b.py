"""Train and select a single-write-only SFT LoRA adapter."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised.common import compute_mean_nll
from tinker_cookbook.supervised.data import conversation_to_datum
from tinker_cookbook.tokenizer_utils import get_tokenizer

from receipts import snapshot_usage, usage_delta

SCRIPT_DIR = Path(__file__).resolve().parent
EXPERIMENT_DIR = SCRIPT_DIR.parent
REPO = EXPERIMENT_DIR.parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts" / "adapter-b"
ORACLE_PATH = ARTIFACT_DIR / "oracle-train.jsonl"
MODEL_NAME = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
RENDERER_NAME = "nemotron3_disable_thinking"
LORA_RANK = 8
EPOCHS = 4
BATCH_SIZE = 4
LEARNING_RATE = 1e-4
MAX_LENGTH = 4096


def _masked_token_ids(datum: tinker.Datum) -> list[int]:
    target = datum.loss_fn_inputs["target_tokens"].data
    weights = datum.loss_fn_inputs["weights"].data
    return [int(token) for token, weight in zip(target, weights, strict=True) if float(weight) > 0]


def _load_rows() -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in ORACLE_PATH.read_text().splitlines() if line.strip()]
    rows = [row for row in rows if row.get("split") == "train" and row.get("band") == "single-write"]
    if len(rows) != 16:
        raise RuntimeError(f"expected 16 single-write train rows, got {len(rows)}")
    if any(row.get("reward") != 1 for row in rows):
        raise RuntimeError("single-write oracle rows must all have reward 1")
    return rows


def _build_datums(rows: list[dict[str, Any]], renderer: Any) -> list[tinker.Datum]:
    datums = [
        conversation_to_datum(
            row["messages"],
            renderer,
            max_length=MAX_LENGTH,
            train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
        )
        for row in rows
    ]
    if not all(_masked_token_ids(datum) for datum in datums):
        raise RuntimeError("every single-write row must have assistant target tokens")
    return datums


def _path(response: Any) -> str:
    value = getattr(response, "path", None)
    if not value:
        raise RuntimeError(f"checkpoint response did not contain a path: {response!r}")
    return str(value)


def _eval(label: str, split: str, model_path: str, out: Path) -> dict[str, Any]:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "evaluate.py"),
        "--split",
        split,
        "--band",
        "single-write",
        "--model-path",
        model_path,
        "--label",
        label,
        "--temperature",
        "0.0",
        "--samples",
        "1",
        "--out",
        str(out),
    ]
    subprocess.run(command, cwd=REPO, check=True)
    return json.loads(out.with_suffix(".summary.json").read_text())


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
    rows = _load_rows()
    datums = _build_datums(rows, renderer)
    (ARTIFACT_DIR / "training-data-selection.json").write_text(
        json.dumps(
            {
                "source": str(ORACLE_PATH),
                "split": "train",
                "band": "single-write",
                "row_count": len(rows),
                "task_ids": [row["task_id"] for row in rows],
                "training_guard": "only split=train and band=single-write rows are reachable",
                "total_model_input_tokens": sum(datum.model_input.length for datum in datums),
                "renderer": RENDERER_NAME,
                "lora_rank": LORA_RANK,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    service_client = tinker.ServiceClient()
    rest_client = service_client.create_rest_client()
    before = snapshot_usage(rest_client)
    training_client = service_client.create_lora_training_client(base_model=MODEL_NAME, rank=LORA_RANK)
    steps_per_epoch = len(datums) // BATCH_SIZE
    checkpoints: list[dict[str, Any]] = []
    step_logs: list[dict[str, Any]] = []
    train_started = time.monotonic()
    for epoch in range(1, EPOCHS + 1):
        for batch_index in range(steps_per_epoch):
            batch = datums[batch_index * BATCH_SIZE : (batch_index + 1) * BATCH_SIZE]
            forward = training_client.forward_backward(batch, loss_fn="cross_entropy").result()
            loss = compute_mean_nll(
                [output["logprobs"] for output in forward.loss_fn_outputs],
                [datum.loss_fn_inputs["weights"] for datum in batch],
            )
            global_step = (epoch - 1) * steps_per_epoch + batch_index
            total_steps = EPOCHS * steps_per_epoch
            learning_rate = LEARNING_RATE * (1 - global_step / max(total_steps - 1, 1))
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
        checkpoints.append({"epoch": epoch, "sampler_path": _path(
            training_client.save_weights_for_sampler(name=f"adapter-b-epoch{epoch}").result()
        )})
    checkpoints[-1]["state_path"] = _path(
        training_client.save_state(name="adapter-b-final-state").result()
    )
    after = snapshot_usage(rest_client)
    (ARTIFACT_DIR / "training-metrics.json").write_text(
        json.dumps(
            {
                "epochs": EPOCHS,
                "steps_per_epoch": steps_per_epoch,
                "lora_rank": LORA_RANK,
                "batch_size": BATCH_SIZE,
                "learning_rate": LEARNING_RATE,
                "wall_clock_seconds": time.monotonic() - train_started,
                "total_model_input_tokens": sum(datum.model_input.length for datum in datums),
                "checkpoints": checkpoints,
                "step_logs": step_logs,
                "usage_delta": usage_delta(before, after),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    dev_results = []
    for checkpoint in checkpoints:
        epoch = checkpoint["epoch"]
        summary = _eval(
            f"adapter-b-epoch{epoch}-dev",
            "dev",
            checkpoint["sampler_path"],
            ARTIFACT_DIR / f"epoch{epoch}-dev.jsonl",
        )
        dev_results.append(
            {
                "epoch": epoch,
                "sampler_path": checkpoint["sampler_path"],
                "mean_reward": summary["mean_reward"],
                "strict_pass_rate": summary["strict_pass_rate"],
                "summary_path": str(ARTIFACT_DIR / f"epoch{epoch}-dev.summary.json"),
            }
        )
    selected = max(dev_results, key=lambda row: (row["mean_reward"], -row["epoch"]))
    selected_train = _eval(
        "adapter-b-selected-train",
        "train",
        selected["sampler_path"],
        ARTIFACT_DIR / "selected-train.jsonl",
    )
    selected_dev = _eval(
        "adapter-b-selected-dev",
        "dev",
        selected["sampler_path"],
        ARTIFACT_DIR / "selected-dev.jsonl",
    )
    selection = {
        "adapter": "B",
        "use_case": "single-write",
        "selected_epoch": selected["epoch"],
        "selected_sampler_path": selected["sampler_path"],
        "selected_state_path": checkpoints[-1]["state_path"],
        "selection_rule": "highest single-write DEV mean reward; earliest epoch tie-break",
        "per_epoch_dev": dev_results,
        "selected_train_summary": selected_train,
        "selected_dev_summary": selected_dev,
        "holdout_accessed": False,
        "fixture_sha256": "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f",
        "holdout_sha256": "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
        "selection_recorded_at_unix": time.time(),
        "wall_clock_seconds_before_holdout": time.monotonic() - started,
    }
    (ARTIFACT_DIR / "selection.json").write_text(json.dumps(selection, indent=2, sort_keys=True) + "\n")
if __name__ == "__main__":
    main()
