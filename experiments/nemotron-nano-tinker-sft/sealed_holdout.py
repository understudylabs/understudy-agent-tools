from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import tinker

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ARTIFACTS = HERE / "artifacts"
sys.path.insert(0, str(HERE))

from driver import (  # noqa: E402
    BASE,
    DEFAULT_MAX_TOKENS,
    EnvDaemon,
    make_context,
    rollout,
    summarize,
)

FROZEN_HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701"
WINNER = "tinker://14b6d378-24d1-5061-9116-1ec78c1ca7a3:train:0/sampler_weights/nemotron-nano-sft-epoch-3"


def write_checkpoint(path, report):
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


async def main(args):
    output_path = Path(args.output)
    if output_path.exists() and not args.resume:
        raise RuntimeError(f"{output_path} already exists; refusing a second sealed event")
    if output_path.exists():
        report = json.loads(output_path.read_text(encoding="utf-8"))
        if report.get("frozen_holdout_sha256") != FROZEN_HOLDOUT_SHA256:
            raise RuntimeError("checkpoint hash does not match the frozen holdout hash")
    else:
        report = {
            "schema_version": "understudy.automationbench.sealed_holdout.v1",
            "event": "single_sealed_holdout_evaluation",
            "frozen_holdout_sha256": FROZEN_HOLDOUT_SHA256,
            "split": "holdout",
            "max_tokens": args.max_tokens,
            "temperature": 0.0,
            "models": {"base": [], "winner": []},
            "completed": False,
        }

    daemon = EnvDaemon()
    try:
        tasks = daemon.call(
            "pool",
            split="holdout",
            frozenHoldoutSha256=FROZEN_HOLDOUT_SHA256,
        )
        if len(tasks) != 12:
            raise RuntimeError(f"expected 12 holdout tasks, found {len(tasks)}")
        task_ids = [task["taskId"] for task in tasks]
        service = tinker.ServiceClient(
            user_metadata={"understudy_experiment": "nemotron-nano-tinker-sft-sealed-holdout"}
        )
        clients = {
            "base": await service.create_sampling_client_async(base_model=BASE),
            "winner": await service.create_sampling_client_async(model_path=WINNER),
        }
        for label in ("base", "winner"):
            completed_ids = {row["task_id"] for row in report["models"][label]}
            for task in tasks:
                if task["taskId"] in completed_ids:
                    continue
                reset_result = daemon.call("reset", taskId=task["taskId"])
                renderer, tokenizer, messages = await make_context(BASE, reset_result["obs"])
                result = await rollout(
                    clients[label],
                    daemon,
                    task["taskId"],
                    renderer,
                    tokenizer,
                    reset_result["obs"],
                    args.max_tokens,
                )
                report["models"][label].append(result)
                report["models"][label].sort(key=lambda row: task_ids.index(row["task_id"]))
                report["summaries"] = {
                    key: summarize(report["models"][key]) for key in ("base", "winner")
                }
                write_checkpoint(output_path, report)
                print(json.dumps({"model": label, "task_id": task["taskId"], "completed": True}), flush=True)
        report["summaries"] = {
            key: summarize(report["models"][key]) for key in ("base", "winner")
        }
        report["completed"] = all(len(report["models"][key]) == 12 for key in ("base", "winner"))
        write_checkpoint(output_path, report)
        print(json.dumps(report, indent=2))
    finally:
        daemon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--output", default=str(ARTIFACTS / "holdout-sealed.json"))
    parser.add_argument("--resume", action="store_true")
    asyncio.run(main(parser.parse_args()))
