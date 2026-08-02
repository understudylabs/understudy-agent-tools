from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from pathlib import Path

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.supervised.common import compute_mean_nll
from tinker_cookbook.supervised.data import conversation_to_datum
from tinker_cookbook.tokenizer_utils import get_tokenizer

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE / "artifacts"
BASE = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
DATASET = ARTIFACTS / "oracle-train.jsonl"
RANK = 16
EPOCHS = 3
BATCH_SIZE = 4
LEARNING_RATE = 5e-5
MAX_LENGTH = 8192


def to_messages(row):
    messages = []
    for message in row["messages"]:
        if message["role"] != "assistant":
            messages.append(renderers.Message(role=message["role"], content=message.get("content", "")))
            continue
        calls = []
        for call in message.get("tool_calls", []):
            fn = call["function"]
            calls.append(
                renderers.ToolCall(
                    type="function",
                    id=None,
                    function=renderers.ToolCall.FunctionBody(
                        name=fn["name"], arguments=fn["arguments"]
                    ),
                )
            )
        messages.append(
            renderers.Message(
                role="assistant",
                content=message.get("content", ""),
                tool_calls=calls,
            )
        )
    return messages


def conversation_for_training(row, renderer):
    messages = to_messages(row)
    tools = [
        {
            "name": "api_search",
            "description": "Read-only endpoint discovery. Args: {query: string, top_k?: number}.",
        },
        {
            "name": "api_fetch",
            "description": "Apply one API call. Args: {method: string, url: string, body?: object}.",
        },
    ]
    prefix = renderer.create_conversation_prefix_with_tools(
        [
            renderers.ToolSpec(
                name="api_search",
                description=tools[0]["description"],
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "top_k": {"type": "integer"},
                    },
                    "required": ["query"],
                },
            ),
            renderers.ToolSpec(
                name="api_fetch",
                description=tools[1]["description"],
                parameters={
                    "type": "object",
                    "properties": {
                        "method": {"type": "string"},
                        "url": {"type": "string"},
                        "body": {"type": "object"},
                    },
                    "required": ["method", "url"],
                },
            ),
        ],
        system_prompt=row["messages"][0]["content"],
    )
    prefix.extend(messages[1:])
    return prefix


def read_rows():
    with DATASET.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


async def main(args):
    if not DATASET.exists():
        raise FileNotFoundError(DATASET)
    rows = read_rows()
    if len(rows) != 48:
        raise RuntimeError(f"expected 48 train rows, found {len(rows)}")
    if any("holdout" in row["task_id"].lower() or row["task_id"].endswith("-05") for row in rows):
        raise RuntimeError("training dataset contains a non-train task id")

    started = time.perf_counter()
    tokenizer = get_tokenizer(BASE)
    renderer = renderers.get_renderer("nemotron3", tokenizer)
    datums = [
        conversation_to_datum(
            conversation_for_training(row, renderer),
            renderer,
            max_length=MAX_LENGTH,
            train_on_what=renderers.TrainOnWhat.ALL_ASSISTANT_MESSAGES,
        )
        for row in rows
    ]
    train_tokens_per_epoch = sum(int(datum.model_input.length) for datum in datums)
    total_steps = math.ceil(len(datums) / args.batch_size) * args.epochs
    service = tinker.ServiceClient(user_metadata={"understudy_experiment": "nemotron-nano-tinker-sft"})
    training = await service.create_lora_training_client_async(
        base_model=BASE,
        rank=args.rank,
        seed=7,
        train_attn=True,
        train_mlp=True,
        train_unembed=True,
        user_metadata={"experiment": "nemotron-nano-tinker-sft", "split": "train-only"},
    )

    loss_curve = []
    checkpoints = []
    step = 0
    for epoch in range(args.epochs):
        epoch_started = time.perf_counter()
        for start in range(0, len(datums), args.batch_size):
            batch = datums[start : start + args.batch_size]
            progress = step / max(total_steps - 1, 1)
            learning_rate = args.learning_rate * max(0.0, 1.0 - progress)
            forward = await training.forward_backward_async(batch, loss_fn="cross_entropy")
            optim = await training.optim_step_async(
                tinker.AdamParams(learning_rate=learning_rate, beta1=0.9, beta2=0.95, eps=1e-8)
            )
            forward_result = await forward.result_async()
            await optim.result_async()
            weights = [datum.loss_fn_inputs["weights"] for datum in batch]
            logprobs = [output["logprobs"] for output in forward_result.loss_fn_outputs]
            loss = float(compute_mean_nll(logprobs, weights))
            if not math.isfinite(loss):
                raise RuntimeError(f"non-finite loss at step {step}: {loss}")
            record = {
                "step": step + 1,
                "epoch": epoch + 1,
                "loss": loss,
                "learning_rate": learning_rate,
                "batch_size": len(batch),
                "tokens": sum(int(datum.model_input.length) for datum in batch),
            }
            loss_curve.append(record)
            print(json.dumps(record), flush=True)
            step += 1
        checkpoint_future = await training.save_weights_for_sampler_async(
            name=f"nemotron-nano-sft-epoch-{epoch + 1}",
            ttl_seconds=args.ttl_seconds,
        )
        checkpoint = await checkpoint_future.result_async()
        checkpoints.append(
            {
                "epoch": epoch + 1,
                "checkpoint_id": checkpoint.path,
                "wall_seconds": round(time.perf_counter() - epoch_started, 3),
            }
        )
        print(json.dumps({"epoch_checkpoint": checkpoints[-1]}), flush=True)

    losses = [item["loss"] for item in loss_curve]
    summary = {
        "schema_version": "understudy.nemotron_nano_tinker_sft.v1",
        "base_model": BASE,
        "lora_rank": args.rank,
        "epochs": args.epochs,
        "steps": step,
        "batch_size": args.batch_size,
        "learning_rate": args.learning_rate,
        "learning_rate_schedule": "linear_decay_to_zero",
        "train_examples": len(rows),
        "train_tokens_per_epoch": train_tokens_per_epoch,
        "train_tokens": train_tokens_per_epoch * args.epochs,
        "loss_first": losses[0],
        "loss_last": losses[-1],
        "loss_min": min(losses),
        "loss_decreased": losses[-1] < losses[0],
        "loss_curve": loss_curve,
        "checkpoints": checkpoints,
        "wall_seconds": round(time.perf_counter() - started, 3),
        "holdout_accessed": False,
        "dev_accessed": False,
    }
    if not summary["loss_decreased"]:
        raise RuntimeError("loss did not decrease; refusing to proceed to evaluation")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--rank", type=int, default=RANK)
    parser.add_argument("--epochs", type=int, default=EPOCHS)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--learning-rate", type=float, default=LEARNING_RATE)
    parser.add_argument("--ttl-seconds", type=int, default=86400)
    parser.add_argument("--output", default=str(ARTIFACTS / "training-receipt.json"))
    asyncio.run(main(parser.parse_args()))
