"""Demonstrate concurrent base and LoRA sampling clients over one base model."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

SCRIPT_DIR = Path(__file__).resolve().parent
EXPERIMENT_DIR = SCRIPT_DIR.parent
REPO = EXPERIMENT_DIR.parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

from env_client import EnvService  # noqa: E402
from rollout import (  # noqa: E402
    MODEL_NAME,
    RENDERER_NAME,
    RolloutConfig,
    rollout_task,
)

ADAPTER_A = "tinker://efb1352d-3e88-572f-8578-ab50ba51d0c6:train:0/sampler_weights/000020"
ADAPTER_B = "tinker://241bbbca-80e4-57db-bcee-1213b6f04e8e:train:0/sampler_weights/adapter-b-epoch1"
ARTIFACT = EXPERIMENT_DIR / "artifacts" / "multi-adapter-tinker" / "serving-demo.json"


async def main() -> None:
    runtime_repo = os.environ.get("AUTOMATIONBENCH_RUNTIME_REPO", str(REPO))
    service = EnvService(runtime_repo).start()
    try:
        tasks = service.tasks("train")
        multi = [task for task in tasks if task["band"] == "multi-write"]
        single = [task for task in tasks if task["band"] == "single-write"]
        if len(multi) < 3 or len(single) < 3:
            raise RuntimeError("expected at least three tasks in multi-write and single-write bands")

        tokenizer = get_tokenizer(MODEL_NAME)
        renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
        service_client = tinker.ServiceClient()
        creation: dict[str, dict[str, object]] = {}
        clients: dict[str, tinker.SamplingClient] = {}
        for name, kwargs in (
            ("base", {"base_model": MODEL_NAME}),
            ("adapter_a", {"model_path": ADAPTER_A}),
            ("adapter_b", {"model_path": ADAPTER_B}),
        ):
            started = time.perf_counter()
            clients[name] = await service_client.create_sampling_client_async(**kwargs)
            creation[name] = {
                "wall_clock_seconds": time.perf_counter() - started,
                "base_model": MODEL_NAME,
                **kwargs,
            }

        sequence = []
        for round_index in range(1, 4):
            for client_name, band, task in (
                ("adapter_a", "multi-write", multi[round_index - 1]),
                ("adapter_b", "single-write", single[round_index - 1]),
            ):
                started = time.perf_counter()
                result = await rollout_task(
                    service,
                    clients[client_name],
                    renderer,
                    task,
                    RolloutConfig(temperature=0.0),
                )
                sequence.append(
                    {
                        "round": round_index,
                        "adapter": client_name,
                        "band": band,
                        "task_id": task["task_id"],
                        "wall_clock_seconds": time.perf_counter() - started,
                        "reward": result["reward"],
                        "strict_pass": result["reward"] == 1.0,
                        "model_turns": result["model_turns"],
                        "env_steps": result["env_steps"],
                        "parse_errors": result["parse_errors"],
                    }
                )

        ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
        ARTIFACT.write_text(
            json.dumps(
                {
                    "base_model": MODEL_NAME,
                    "renderer": RENDERER_NAME,
                    "adapter_paths": {"adapter_a": ADAPTER_A, "adapter_b": ADAPTER_B},
                    "client_creation": creation,
                    "interleaved_sequence": sequence,
                    "conclusions": {
                        "one_service_client": True,
                        "clients_open_concurrently": True,
                        "teardown_between_swaps": False,
                        "rounds": 3,
                        "adapter_a_band": "multi-write",
                        "adapter_b_band": "single-write",
                        "adapter_a_all_strict_pass": all(
                            row["strict_pass"]
                            for row in sequence
                            if row["adapter"] == "adapter_a"
                        ),
                        "adapter_b_all_strict_pass": all(
                            row["strict_pass"]
                            for row in sequence
                            if row["adapter"] == "adapter_b"
                        ),
                    },
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
    finally:
        service.stop()


if __name__ == "__main__":
    asyncio.run(main())
