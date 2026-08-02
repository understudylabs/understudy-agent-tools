"""Single-use sealed holdout evaluator for a completed lane."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from env_client import EnvService
from runner import (
    ARTIFACT_DIR,
    HOLDOUT_SHA256,
    RENDERERS,
    ServerlessBackend,
    TokenMeter,
    TinkerBackend,
    _renderer_for,
    rollout,
)

REPO = Path(__file__).resolve().parents[2]


def _close_sampler(sampler: Any) -> None:
    close = getattr(sampler, "close", None)
    if close:
        close()


def evaluate_checkpoint(
    env: EnvService,
    backend: Any,
    model: str,
    tokenizer: Any,
    renderer: Any,
    checkpoint_name: str,
    checkpoint_path: str,
    temperature: float,
    samples: int,
) -> dict[str, Any]:
    sampler = backend.create_sampling_client(checkpoint_path, tokenizer)
    meter = TokenMeter(model=model, phase=f"holdout-{checkpoint_name}-t{temperature}")
    try:
        rows = []
        tasks = env.tasks("holdout", frozen_holdout_sha256=HOLDOUT_SHA256)
        for task in tasks:
            for sample_index in range(samples):
                result = rollout(
                    env,
                    sampler,
                    renderer,
                    task,
                    meter,
                    temperature=temperature,
                    tokenizer=tokenizer,
                    frozen_holdout_sha256=HOLDOUT_SHA256,
                )
                rows.append(
                    {
                        "task_id": result.task_id,
                        "sample_index": sample_index,
                        "reward": result.reward,
                        "parse_errors": result.parse_errors,
                        "model_turns": len(result.turns),
                        "env_steps": result.env_steps,
                    }
                )
        return {
            "checkpoint": checkpoint_name,
            "checkpoint_path": checkpoint_path,
            "temperature": temperature,
            "samples_per_task": samples,
            "count": len(rows),
            "mean_reward": sum(row["reward"] for row in rows) / len(rows),
            "strict_pass_rate": sum(row["reward"] == 1.0 for row in rows) / len(rows),
            "reward_distribution": {
                str(reward): sum(row["reward"] == reward for row in rows)
                for reward in sorted({row["reward"] for row in rows})
            },
            "parse_errors": sum(len(row["parse_errors"]) for row in rows),
            "receipt": meter.receipt(),
            "rows": rows,
        }
    finally:
        _close_sampler(sampler)


def run(model: str, backend_name: str, training_artifact: Path, output: Path) -> None:
    if output.exists():
        raise RuntimeError(
            f"sealed holdout artifact already exists: {output}; refusing to rerun"
        )
    artifact = json.loads(training_artifact.read_text())
    tokenizer, renderer, tokenizer_name, renderer_name = _renderer_for(model)
    backend_cls = ServerlessBackend if backend_name == "serverless" else TinkerBackend
    env = EnvService(str(REPO)).start()
    backend = None
    started = time.monotonic()
    try:
        hashes = env.hashes()
        if hashes["split_sha256"]["holdout"] != HOLDOUT_SHA256:
            raise RuntimeError(f"holdout hash mismatch: {hashes}")
        backend = backend_cls(model=model, rank=32)
        base_path = backend.save_weights_for_sampler("sealed-holdout-base")
        checkpoints = {
            "base": base_path,
            "sft": artifact["sft"]["selected"]["path"],
            "grpo": artifact["grpo"]["checkpoints"][-1]["path"],
        }
        evaluations = []
        for checkpoint_name, checkpoint_path in checkpoints.items():
            evaluations.append(
                evaluate_checkpoint(
                    env, backend, model, tokenizer, renderer,
                    checkpoint_name, checkpoint_path, 0.0, 1,
                )
            )
            evaluations.append(
                evaluate_checkpoint(
                    env, backend, model, tokenizer, renderer,
                    checkpoint_name, checkpoint_path, 1.0, 4,
                )
            )
        result = {
            "schema": "automationbench.sealed_holdout.v1",
            "model": model,
            "backend": backend_name,
            "tokenizer": tokenizer_name,
            "renderer": renderer_name,
            "fixture_sha256": hashes["fixture_sha256"],
            "holdout_sha256": HOLDOUT_SHA256,
            "training_artifact": str(training_artifact),
            "evaluations": evaluations,
            "wall_seconds": time.monotonic() - started,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{output.name}.", suffix=".tmp", dir=output.parent
        )
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(result, stream, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, output)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        print(json.dumps(result, indent=2), flush=True)
    finally:
        if backend is not None:
            backend.close()
        env.stop()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=sorted(RENDERERS), required=True)
    parser.add_argument("--backend", choices=["serverless", "tinker"], default="serverless")
    parser.add_argument("--training-artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--frozen-holdout-sha256", required=True, choices=[HOLDOUT_SHA256]
    )
    args = parser.parse_args()
    run(args.model, args.backend, args.training_artifact, args.output)


if __name__ == "__main__":
    main()
