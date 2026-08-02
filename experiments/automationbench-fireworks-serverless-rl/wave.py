"""Warm-client SFT→GRPO Fireworks serverless wave.

This is intentionally train/dev-only. Each process owns one serverless client
for one model and releases its session in ``finally`` through the backend.
"""

from __future__ import annotations

import json
import random
import statistics
import sys
import time
from pathlib import Path

import tinker
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised.data import conversation_to_datum

from env_client import EnvService
from runner import (
    ARTIFACT_DIR,
    DEFAULT_MAX_TOKENS,
    ServerlessBackend,
    TinkerBackend,
    TokenMeter,
    _build_datums,
    _oracle_rows,
    _renderer_for,
    _write_transcript,
    run_gate,
    rollout,
    train_step,
)

REPO = Path(__file__).resolve().parents[2]
EPOCHS = 4
BATCH_SIZE = 16
SFT_LR = 1e-4
GROUP_SIZE = 8
GROUPS_PER_STEP = 8
GRPO_STEPS = 40
GRPO_LR = 1e-5
TOTAL_CAP_USD = 120.0


def _close_sampler(sampler: Any) -> None:
    close = getattr(sampler, "close", None)
    if close:
        close()


def _sft_datums(rows, renderer, tokenizer):
    datums = []
    for row in rows:
        conversation = row["messages"]
        for index, message in enumerate(conversation):
            if message["role"] != "assistant":
                continue
            prefix = conversation[: index + 1]
            datums.append(
                conversation_to_datum(
                    prefix,
                    renderer,
                    max_length=4096,
                    train_on_what=TrainOnWhat.LAST_ASSISTANT_MESSAGE,
                )
            )
    return datums


def _eval_checkpoint(
    env,
    backend,
    model,
    tokenizer,
    renderer,
    split,
    meter,
    sampler_path,
    transcript_dir=None,
):
    sampler = backend.create_sampling_client(sampler_path, tokenizer)
    try:
        rows = []
        for task in env.tasks(split):
            result = rollout(
                env,
                sampler,
                renderer,
                task,
                meter,
                temperature=0.0,
                max_tokens=DEFAULT_MAX_TOKENS,
                tokenizer=tokenizer,
            )
            rows.append(
                {
                    "task_id": result.task_id,
                    "reward": result.reward,
                    "parse_errors": result.parse_errors,
                    "model_turns": len(result.turns),
                }
            )
            if transcript_dir and len(rows) <= 3:
                _write_transcript(transcript_dir, model, split, None, result)
    finally:
        _close_sampler(sampler)
    return {
        "count": len(rows),
        "mean_reward": statistics.fmean(row["reward"] for row in rows),
        "strict_pass_rate": statistics.fmean(row["reward"] == 1.0 for row in rows),
        "parse_errors": sum(len(row["parse_errors"]) for row in rows),
        "reward_distribution": {
            str(reward): sum(row["reward"] == reward for row in rows)
            for reward in sorted({row["reward"] for row in rows})
        },
        "rows": rows,
    }


def run_model(
    model: str,
    backend_name: str = "serverless",
    output_path: Path | None = None,
) -> dict:
    started = time.monotonic()
    env = EnvService(str(REPO)).start()
    backend = None
    try:
        run_gate(env)
        tokenizer, renderer, tokenizer_name, renderer_name = _renderer_for(model)
        backend_cls = ServerlessBackend if backend_name == "serverless" else TinkerBackend
        backend = backend_cls(model=model, rank=32)
        client_constructed = time.monotonic()
        oracle_rows = _oracle_rows()
        sft_datums = _sft_datums(oracle_rows, renderer, tokenizer)
        sft_meter = TokenMeter(model=model, phase="sft")
        sft_started = time.monotonic()
        sft_logs = []
        sft_checkpoints = []
        first_gradient_seconds = None
        for epoch in range(1, EPOCHS + 1):
            for batch_start in range(0, len(sft_datums), BATCH_SIZE):
                batch = sft_datums[batch_start : batch_start + BATCH_SIZE]
                fb_started = time.monotonic()
                forward = backend.training_client.forward_backward(
                    batch, "cross_entropy"
                ).result()
                if first_gradient_seconds is None:
                    first_gradient_seconds = time.monotonic() - client_constructed
                optim_started = time.monotonic()
                backend.training_client.optim_step(
                    tinker.AdamParams(
                        learning_rate=SFT_LR,
                        beta1=0.9,
                        beta2=0.95,
                        eps=1e-8,
                    )
                ).result()
                batch_tokens = sum(d.model_input.length for d in batch)
                sft_meter.add_train(batch_tokens)
                sft_logs.append(
                    {
                        "epoch": epoch,
                        "step": len(sft_logs) + 1,
                        "batch_tokens": batch_tokens,
                        "forward_backward_seconds": time.monotonic() - fb_started,
                        "optim_step_seconds": time.monotonic() - optim_started,
                        "metrics": getattr(forward, "metrics", None),
                    }
                )
            checkpoint_path = backend.save_weights_for_sampler(f"sft-epoch-{epoch}")
            sft_checkpoints.append({"epoch": epoch, "path": checkpoint_path})
        sft_dev_meter = TokenMeter(model=model, phase="sft-dev")
        sft_dev = _eval_checkpoint(
            env,
            backend,
            model,
            tokenizer,
            renderer,
            "dev",
            sft_dev_meter,
            sft_checkpoints[-1]["path"],
        )
        # Selection is dev-only. Latest epoch is the explicit tie-break.
        selected = sft_checkpoints[-1]

        rng = random.Random(7)
        train_tasks = env.tasks("train")
        grpo_meter = TokenMeter(model=model, phase="grpo")
        grpo_started = time.monotonic()
        grpo_logs = []
        dev_checkpoints = []
        for step in range(1, GRPO_STEPS + 1):
            chosen_tasks = rng.sample(train_tasks, GROUPS_PER_STEP)
            rollouts = []
            sampler_path = backend.save_weights_for_sampler(f"grpo-pre-step-{step}")
            sampler = backend.create_sampling_client(sampler_path, tokenizer)
            try:
                for task in chosen_tasks:
                    for _ in range(GROUP_SIZE):
                        rollouts.append(
                            rollout(
                                env,
                                sampler,
                                renderer,
                                task,
                                grpo_meter,
                                temperature=1.0,
                                max_tokens=DEFAULT_MAX_TOKENS,
                                tokenizer=tokenizer,
                            )
                        )
            finally:
                _close_sampler(sampler)
            datums = _build_datums(rollouts)
            update = train_step(backend, datums, grpo_meter, learning_rate=GRPO_LR)
            update["step"] = step
            update["rollout_count"] = len(rollouts)
            update["reward_distribution"] = {
                str(reward): sum(item.reward == reward for item in rollouts)
                for reward in sorted({item.reward for item in rollouts})
            }
            grpo_logs.append(update)
            if step % 5 == 0:
                checkpoint = backend.save_weights_for_sampler(f"grpo-step-{step}")
                dev_checkpoints.append({"step": step, "path": checkpoint})
            if step in {10, 20, 30, 40}:
                dev_meter = TokenMeter(model=model, phase=f"grpo-dev-{step}")
                dev = _eval_checkpoint(
                    env,
                    backend,
                    model,
                    tokenizer,
                    renderer,
                    "dev",
                    dev_meter,
                    dev_checkpoints[-1]["path"],
                )
                grpo_logs[-1]["dev"] = dev
            if grpo_meter.usd > TOTAL_CAP_USD:
                raise RuntimeError(f"wave cap exceeded: {grpo_meter.usd:.4f} > {TOTAL_CAP_USD}")
        result = {
            "model": model,
            "backend": backend_name,
            "tokenizer": tokenizer_name,
            "renderer": renderer_name,
            "first_gradient_seconds": first_gradient_seconds,
            "sft": {
                "wall_seconds": time.monotonic() - sft_started,
                "meter": sft_meter.receipt(),
                "logs": sft_logs,
                "checkpoints": sft_checkpoints,
                "selected": selected,
                "dev": sft_dev,
                "dev_meter": sft_dev_meter.receipt(),
            },
            "grpo": {
                "wall_seconds": time.monotonic() - grpo_started,
                "meter": grpo_meter.receipt(),
                "logs": grpo_logs,
                "checkpoints": dev_checkpoints,
            },
            "total_wall_seconds": time.monotonic() - started,
        }
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        output = output_path or (
            ARTIFACT_DIR / f"wave-{model.rsplit('/', 1)[-1]}.json"
        )
        output.write_text(
            json.dumps(result, indent=2, default=str) + "\n"
        )
        print(json.dumps(result, indent=2, default=str), flush=True)
        return result
    finally:
        if backend is not None:
            backend.close()
        env.stop()


if __name__ == "__main__":
    run_model(
        sys.argv[1],
        sys.argv[2] if len(sys.argv) > 2 else "serverless",
        Path(sys.argv[3]) if len(sys.argv) > 3 else None,
    )
