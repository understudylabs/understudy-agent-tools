"""SFT warm-start for the AutomationBench Nemotron arm.

This is intentionally an isolated experiment harness rather than product
runtime code. It regenerates oracle data from the checked-in Node evaluator,
trains a configurable-rank LoRA adapter, and evaluates every saved epoch checkpoint
through the shared rollout driver.
"""

from __future__ import annotations

import argparse
import json
import statistics
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

from receipts import service_client, snapshot_usage, usage_delta
from rollout import LORA_RANK, MODEL_NAME, RENDERER_DEVIATION, RENDERER_NAME

REPO = Path(__file__).resolve().parents[2]
EXPERIMENT_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
MAX_LENGTH = 4096
BATCH_SIZE = 16
EPOCHS = 4
LEARNING_RATE = 1e-4
VARIANCE_LIMIT = 8
VARIANCE_SAMPLES = 8


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-training", action="store_true")
    parser.add_argument("--lora-rank", type=int, default=LORA_RANK)
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--max-length", type=int, default=MAX_LENGTH)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    return parser.parse_args()


def _run_node_export(oracle_path: Path) -> None:
    oracle_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "node",
            "scripts/automationbench-oracle-trajectories.mjs",
            "--out",
            str(oracle_path),
        ],
        cwd=REPO,
        check=True,
    )


def _load_oracle_rows(oracle_path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in oracle_path.read_text().splitlines() if line.strip()]
    if len(rows) != 48:
        raise RuntimeError(f"expected 48 oracle rows, got {len(rows)}")
    for row in rows:
        if row.get("split") != "train":
            raise RuntimeError(f"oracle row is not train-only: {row.get('task_id')}")
        if row.get("reward") != 1:
            raise RuntimeError(f"oracle reward is not 1.0: {row.get('task_id')}")
    return rows


def _masked_token_ids(datum: tinker.Datum) -> list[int]:
    target = datum.loss_fn_inputs["target_tokens"].data
    weights = datum.loss_fn_inputs["weights"].data
    return [int(token) for token, weight in zip(target, weights, strict=True) if float(weight) > 0]


def _build_datums(
    rows: list[dict[str, Any]],
    renderer: renderers.Renderer,
    max_length: int,
    tokenizer: Any,
) -> tuple[list[tinker.Datum], dict[str, Any]]:
    datums: list[tinker.Datum] = []
    lengths: list[int] = []
    masked_lengths: list[int] = []
    spot_check: dict[str, Any] | None = None
    for row in rows:
        conversation = row["messages"]
        datum = conversation_to_datum(
            conversation,
            renderer,
            max_length=max_length,
            train_on_what=TrainOnWhat.ALL_ASSISTANT_MESSAGES,
        )
        datums.append(datum)
        lengths.append(datum.model_input.length)
        masked = _masked_token_ids(datum)
        masked_lengths.append(len(masked))
        if spot_check is None:
            assistant_strings = [
                message["content"]
                for message in conversation
                if message["role"] == "assistant"
            ]
            masked_text = tokenizer.decode(masked, skip_special_tokens=False)
            spot_check = {
                "task_id": row["task_id"],
                "assistant_targets": assistant_strings,
                "masked_token_count": len(masked),
                "masked_decoded": masked_text,
                "all_assistant_targets_found": all(
                    target in masked_text for target in assistant_strings
                ),
                "target_tokens": masked,
            }
    assert spot_check is not None
    if not spot_check["all_assistant_targets_found"]:
        raise RuntimeError("assistant-only mask does not cover every assistant JSON action")
    return datums, {
        "count": len(datums),
        "max_length": max_length,
        "token_lengths": {
            "min": min(lengths),
            "max": max(lengths),
            "mean": statistics.fmean(lengths),
            "median": statistics.median(lengths),
        },
        "masked_token_lengths": {
            "min": min(masked_lengths),
            "max": max(masked_lengths),
            "mean": statistics.fmean(masked_lengths),
            "median": statistics.median(masked_lengths),
        },
        "spot_check": spot_check,
    }


def _phase_receipt(
    rest_client: Any,
    phase: str,
    before: dict[str, Any],
    after: dict[str, Any],
    path: Path,
) -> dict[str, Any]:
    receipt = {
        "phase": phase,
        "before": before,
        "after": after,
        "delta": usage_delta(before, after),
    }
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def _extract_path(response: Any) -> str:
    path = getattr(response, "path", None)
    if not path:
        raise RuntimeError(f"Tinker checkpoint response did not contain a path: {response!r}")
    return str(path)


def _train(
    datums: list[tinker.Datum],
    service_client: tinker.ServiceClient,
    rest_client: Any,
    epochs: int,
    batch_size: int,
    learning_rate: float,
    lora_rank: int,
    artifact_dir: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if len(datums) % batch_size:
        raise RuntimeError("batch size must divide 48 so every epoch has exactly 3 steps")
    training_client = service_client.create_lora_training_client(
        base_model=MODEL_NAME,
        rank=lora_rank,
    )
    steps_per_epoch = len(datums) // batch_size
    total_steps = epochs * steps_per_epoch
    logs: list[dict[str, Any]] = []
    checkpoints: list[dict[str, Any]] = []
    started = time.monotonic()
    tokens_seen = 0
    for epoch in range(1, epochs + 1):
        for batch_index in range(steps_per_epoch):
            global_step = (epoch - 1) * steps_per_epoch + batch_index
            batch = datums[batch_index * batch_size : (batch_index + 1) * batch_size]
            forward = training_client.forward_backward(batch, loss_fn="cross_entropy").result()
            logprobs = [output["logprobs"] for output in forward.loss_fn_outputs]
            weights = [datum.loss_fn_inputs["weights"] for datum in batch]
            loss = compute_mean_nll(logprobs, weights)
            if total_steps == 1:
                current_lr = 0.0
            else:
                current_lr = learning_rate * (1.0 - global_step / (total_steps - 1))
            training_client.optim_step(
                tinker.AdamParams(
                    learning_rate=current_lr,
                    beta1=0.9,
                    beta2=0.95,
                    eps=1e-8,
                )
            ).result()
            batch_tokens = sum(datum.model_input.length for datum in batch)
            tokens_seen += batch_tokens
            entry = {
                "epoch": epoch,
                "batch": batch_index + 1,
                "global_step": global_step + 1,
                "loss": loss,
                "learning_rate": current_lr,
                "batch_tokens": batch_tokens,
                "elapsed_seconds": time.monotonic() - started,
            }
            logs.append(entry)
            print(json.dumps({"sft_step": entry}, sort_keys=True), flush=True)
        sampler_response = training_client.save_weights_for_sampler(
            name=f"sft-epoch{epoch}"
        ).result()
        sampler_path = _extract_path(sampler_response)
        state_response = training_client.save_state(name=f"sft-epoch{epoch}-state").result()
        checkpoint: dict[str, Any] = {
            "epoch": epoch,
            "sampler_path": sampler_path,
            "state_path": _extract_path(state_response),
        }
        checkpoints.append(checkpoint)
        print(json.dumps({"sft_checkpoint": checkpoint}, sort_keys=True), flush=True)
    metrics = {
        "epochs": epochs,
        "steps_per_epoch": steps_per_epoch,
        "total_steps": total_steps,
        "tokens_seen": tokens_seen,
        "wall_clock_seconds": time.monotonic() - started,
        "step_logs": logs,
        "checkpoints": checkpoints,
        "lora_rank": lora_rank,
        "learning_rate": learning_rate,
        "renderer": RENDERER_NAME,
        "renderer_deviation": RENDERER_DEVIATION,
    }
    (artifact_dir / "sft-checkpoints.json").write_text(
        json.dumps({"checkpoints": checkpoints, "last_state_path": checkpoints[-1].get("state_path")}, indent=2)
        + "\n"
    )
    (artifact_dir / "sft-step-log.jsonl").write_text(
        "".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in logs)
    )
    return checkpoints, metrics


def _run_evaluation(
    label: str,
    split: str,
    model_path: str,
    out_path: Path,
    lora_rank: int,
    samples: int = 1,
    temperature: float = 0.0,
    limit: int | None = None,
) -> dict[str, Any]:
    command = [
        sys.executable,
        str(EXPERIMENT_DIR / "evaluate.py"),
        "--split",
        split,
        "--model-path",
        model_path,
        "--lora-rank",
        str(lora_rank),
        "--label",
        label,
        "--temperature",
        str(temperature),
        "--samples",
        str(samples),
        "--out",
        str(out_path),
    ]
    if limit is not None:
        command.extend(["--limit", str(limit)])
    subprocess.run(command, cwd=REPO, check=True)
    return json.loads(out_path.with_suffix(".summary.json").read_text())


def _select_sft_checkpoint(dev_results: list[dict[str, Any]]) -> dict[str, Any]:
    """prefer the latest tied epoch, because RL initializes from its saved LoRA state"""

    return max(dev_results, key=lambda row: (row["mean_reward"], row["epoch"]))


def main() -> None:
    args = _args()
    if (
        args.epochs < 1
        or args.batch_size < 1
        or args.max_length < 1
        or args.lora_rank < 1
    ):
        raise SystemExit("epochs, batch size, max length, and LoRA rank must be positive")
    artifact_dir = ARTIFACT_DIR / "sweep" / f"rank{args.lora_rank}"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    oracle_path = artifact_dir / "oracle-train.jsonl"
    client = service_client()
    rest_client = client.create_rest_client()

    data_before = snapshot_usage(rest_client)
    data_started = time.monotonic()
    _run_node_export(oracle_path)
    rows = _load_oracle_rows(oracle_path)
    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
    datums, data_metrics = _build_datums(rows, renderer, args.max_length, tokenizer)
    data_metrics["wall_clock_seconds"] = time.monotonic() - data_started
    data_metrics["token_count_total"] = sum(datum.model_input.length for datum in datums)
    data_metrics["oracle_path"] = str(oracle_path)
    (artifact_dir / "sft-data-metrics.json").write_text(
        json.dumps(data_metrics, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps({"sft_data": data_metrics}, indent=2), flush=True)
    data_after = snapshot_usage(rest_client)
    _phase_receipt(
        rest_client,
        "sft-data",
        data_before,
        data_after,
        artifact_dir / "sft-data.usage.json",
    )

    if args.skip_training:
        return

    train_before = snapshot_usage(rest_client)
    train_started = time.monotonic()
    checkpoints, train_metrics = _train(
        datums,
        client,
        rest_client,
        epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
        lora_rank=args.lora_rank,
        artifact_dir=artifact_dir,
    )
    train_metrics["wall_clock_seconds"] = time.monotonic() - train_started
    (artifact_dir / "sft-training-metrics.json").write_text(
        json.dumps(train_metrics, indent=2, sort_keys=True) + "\n"
    )
    train_after = snapshot_usage(rest_client)
    _phase_receipt(
        rest_client,
        "sft-training",
        train_before,
        train_after,
        artifact_dir / "sft-training.usage.json",
    )

    dev_results: list[dict[str, Any]] = []
    evaluation_phases: list[dict[str, Any]] = []
    for checkpoint in checkpoints:
        epoch = checkpoint["epoch"]
        evaluation_started = time.monotonic()
        summary = _run_evaluation(
            f"sft-epoch{epoch}-dev",
            "dev",
            checkpoint["sampler_path"],
            artifact_dir / f"sft-epoch{epoch}-dev.jsonl",
            lora_rank=args.lora_rank,
        )
        dev_results.append(
            {
                "epoch": epoch,
                "sampler_path": checkpoint["sampler_path"],
                "state_path": checkpoint["state_path"],
                "mean_reward": summary["mean_reward"],
                "strict_pass_rate": summary["strict_pass_rate"],
                "summary_path": str(artifact_dir / f"sft-epoch{epoch}-dev.summary.json"),
            }
        )
        evaluation_phases.append(
            {
                "phase": f"sft-epoch{epoch}-dev",
                "split": "dev",
                "wall_clock_seconds": time.monotonic() - evaluation_started,
                "prompt_tokens": summary["total_prompt_tokens"],
                "sampled_tokens": summary["total_sampled_tokens"],
            }
        )
    selected = _select_sft_checkpoint(dev_results)
    selected_path = selected["sampler_path"]
    evaluation_started = time.monotonic()
    selected_train = _run_evaluation(
        "sft-selected-train",
        "train",
        selected_path,
        artifact_dir / "sft-selected-train.jsonl",
        lora_rank=args.lora_rank,
    )
    evaluation_phases.append(
        {
            "phase": "sft-selected-train",
            "split": "train",
            "wall_clock_seconds": time.monotonic() - evaluation_started,
            "prompt_tokens": selected_train["total_prompt_tokens"],
            "sampled_tokens": selected_train["total_sampled_tokens"],
        }
    )
    evaluation_started = time.monotonic()
    selected_dev = _run_evaluation(
        "sft-selected-dev",
        "dev",
        selected_path,
        artifact_dir / "sft-selected-dev.jsonl",
        lora_rank=args.lora_rank,
    )
    evaluation_phases.append(
        {
            "phase": "sft-selected-dev",
            "split": "dev",
            "wall_clock_seconds": time.monotonic() - evaluation_started,
            "prompt_tokens": selected_dev["total_prompt_tokens"],
            "sampled_tokens": selected_dev["total_sampled_tokens"],
        }
    )
    evaluation_started = time.monotonic()
    selected_variance = _run_evaluation(
        "sft-selected-variance-train-8x8",
        "train",
        selected_path,
        artifact_dir / "sft-selected-variance-train-8x8.jsonl",
        samples=VARIANCE_SAMPLES,
        temperature=1.0,
        limit=VARIANCE_LIMIT,
        lora_rank=args.lora_rank,
    )
    evaluation_phases.append(
        {
            "phase": "sft-selected-variance-train-8x8",
            "split": "train",
            "wall_clock_seconds": time.monotonic() - evaluation_started,
            "prompt_tokens": selected_variance["total_prompt_tokens"],
            "sampled_tokens": selected_variance["total_sampled_tokens"],
        }
    )
    (artifact_dir / "sft-phase-metrics.json").write_text(
        json.dumps(
            {
                "data": {
                    "wall_clock_seconds": data_metrics["wall_clock_seconds"],
                    "local_tokens": data_metrics["token_count_total"],
                },
                "training": {
                    "wall_clock_seconds": train_metrics["wall_clock_seconds"],
                    "model_input_tokens": train_metrics["tokens_seen"],
                },
                "evaluations": evaluation_phases,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    selection = {
        "lora_rank": args.lora_rank,
        "per_epoch_dev": dev_results,
        "selected_epoch": selected["epoch"],
        "selected_sampler_path": selected_path,
        "selected_state_path": selected["state_path"],
        "selection_rule": "best dev reward, ties select latest epoch",
        "selection_rationale": (
            "Select the highest dev reward; when tied, select the latest "
            "epoch. Every epoch has a resumable state artifact."
        ),
        "selected_train_summary": selected_train,
        "selected_dev_summary": selected_dev,
        "selected_variance_summary": selected_variance,
        "selected_train_summary_path": str(artifact_dir / "sft-selected-train.summary.json"),
        "selected_dev_summary_path": str(artifact_dir / "sft-selected-dev.summary.json"),
        "selected_variance_summary_path": str(
            artifact_dir / "sft-selected-variance-train-8x8.summary.json"
        ),
        "baseline_summary_paths": [
            str(ARTIFACT_DIR / "baseline-train.summary.json"),
            str(ARTIFACT_DIR / "baseline-dev.summary.json"),
            str(ARTIFACT_DIR / "variance-train-8x8.summary.json"),
        ],
    }
    selection_json = json.dumps(selection, indent=2, sort_keys=True) + "\n"
    (ARTIFACT_DIR / f"sft-selection-rank{args.lora_rank}.json").write_text(selection_json)
    print(
        json.dumps(
            {
                "selected_epoch": selected["epoch"],
                "selected_sampler_path": selected_path,
                "selected_train_mean_reward": selected_train["mean_reward"],
                "selected_dev_mean_reward": selected_dev["mean_reward"],
                "selected_variance_nonzero_groups": sum(
                    group["reward_std"] > 0 for group in selected_variance["groups"]
                ),
            },
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
