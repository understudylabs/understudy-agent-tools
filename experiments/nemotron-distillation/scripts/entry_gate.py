"""Fail-closed Phase A integrity and verifier gate."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from env_client import EnvService, EnvServiceError
from events import emit_event
from step_runtime import record_completed, replay_or_start, synchronous_job_ref

SERVICE_REPO_DEFAULT = "/home/ubuntu/wt-402"
FIXTURE_SHA256 = "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f"
SPLIT_SHA256 = {
    "train": "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89",
    "dev": "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc",
    "holdout": "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
}
ARTIFACT = Path(__file__).resolve().parents[1] / "artifacts" / "entry-gate.json"


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-repo", default=SERVICE_REPO_DEFAULT)
    parser.add_argument("--out", default=str(ARTIFACT))
    parser.add_argument("--experiment-id", default="P3-nemotron-distillation")
    parser.add_argument("--candidate-id", default="entry-gate")
    parser.add_argument("--attempt", type=int, default=1)
    return parser.parse_args()


def _sentinel_scores(service_repo: str, task_ids: list[str]) -> list[dict[str, object]]:
    module = str(Path(service_repo) / "dist" / "automationbench-offline.js")
    source = """
const { getTask, sentinelPolicy, rollout } = await import(process.argv[1]);
const ids = JSON.parse(process.argv[2]);
const rows = ids.map(taskId => {
  const row = rollout(taskId, sentinelPolicy());
  return { task_id: row.taskId, split: row.split, reward: row.reward, forbidden_effects: row.forbiddenEffects };
});
console.log(JSON.stringify(rows));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", source, module, json.dumps(task_ids)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def main() -> None:
    args = _args()
    key, replay = replay_or_start(args.experiment_id, args.candidate_id, args.attempt)
    if replay is not None:
        print(json.dumps(replay, indent=2))
        return
    service = EnvService(args.service_repo).start()
    try:
        hashes = service.hashes()
        hash_pass = (
            hashes["fixture_sha256"] == FIXTURE_SHA256
            and hashes["split_sha256"] == SPLIT_SHA256
        )
        train = service.tasks("train")
        sanity_tasks = [
            next(task for task in train if task["band"] == band)
            for band in ("single-write", "discovery", "multi-write")
        ]
        oracle_rows = []
        for task in sanity_tasks:
            trajectory = service.oracle_trajectory(task["task_id"])
            oracle_rows.append({
                "task_id": trajectory["task_id"],
                "split": trajectory["split"],
                "band": trajectory["band"],
                "reward": trajectory["reward"],
            })
        oracle_pass = all(float(row["reward"]) == 1.0 for row in oracle_rows)

        sentinel_rows = _sentinel_scores(args.service_repo, [task["task_id"] for task in sanity_tasks])
        for row, task in zip(sentinel_rows, sanity_tasks, strict=True):
            row["band"] = task["band"]
        sentinel_pass = all(float(row["reward"]) == 0.0 for row in sentinel_rows)

        holdout_errors: dict[str, str] = {}
        for label, value in (("missing", None), ("wrong", "0" * 64)):
            try:
                service.tasks("holdout", value)
            except EnvServiceError as error:
                holdout_errors[label] = str(error)
        holdout_accepts = len(service.tasks("holdout", SPLIT_SHA256["holdout"])) == 12
        holdout_pass = set(holdout_errors) == {"missing", "wrong"} and holdout_accepts

        checks = {
            "oracle_replay_reward": {
                "pass": oracle_pass,
                "tasks": oracle_rows,
                "bands": sorted(task["band"] for task in sanity_tasks),
            },
            "sentinel_reward_zero": {
                "pass": sentinel_pass,
                "rows": sentinel_rows,
            },
            "holdout_access_gate": {
                "pass": holdout_pass,
                "missing_hash_refused": "missing" in holdout_errors,
                "wrong_hash_refused": "wrong" in holdout_errors,
                "exact_hash_accepted": holdout_accepts,
                "expected_hash": SPLIT_SHA256["holdout"],
            },
            "frozen_hashes": {
                "pass": hash_pass,
                "observed": hashes,
                "expected": {"fixture_sha256": FIXTURE_SHA256, "split_sha256": SPLIT_SHA256},
            },
        }
        result = {
            "schema_version": "understudy.eval_result.v1",
            "run_id": "P3-entry-gate",
            "task_id": "entry-gate",
            "split": "train",
            "status": "ok" if all(check["pass"] for check in checks.values()) else "error",
            "score": 1.0 if all(check["pass"] for check in checks.values()) else 0.0,
            "model": "verifier-only",
            "base_model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
            "renderer": "nemotron3_disable_thinking",
            "lora_rank": 32,
            "steps": 0,
            "dataset_seed": 7,
            "dataset_hash": FIXTURE_SHA256,
            "sealed_holdout_sha256": SPLIT_SHA256["holdout"],
            "provider": "local-offline-sim",
            "cost": {"usd": 0, "basis": "local-zero-marginal-cost"},
            "per_band_scores": {
                task["band"]: float(row["reward"])
                for task, row in zip(sanity_tasks, oracle_rows, strict=True)
            },
            "checks": checks,
            "provenance": {
                "service_repo": args.service_repo,
                "prompt_variant": "nemotron-v1",
                "fixture_sha256": FIXTURE_SHA256,
                "split_sha256": SPLIT_SHA256,
            },
        }
        output = Path(args.out)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        replay_result = {
            "out": str(output),
            "status": result["status"],
            "score": result["score"],
            "job_ref": synchronous_job_ref(key),
        }
        record_completed(
            key, args.experiment_id, args.candidate_id, args.attempt, replay_result
        )
        emit_event(
            "run",
            "phase_completed",
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            phase="entry-gate",
            status=result["status"],
        )
        emit_event(
            "score",
            "snapshot",
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            phase="entry-gate",
            score=result["score"],
        )
        print(json.dumps(result, indent=2))
        if result["status"] != "ok":
            raise SystemExit(1)
    finally:
        service.stop()


if __name__ == "__main__":
    main()
