"""Build the canonical executor-submit payload without provider access."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from models import get_model_spec
from step_runtime import record_completed, replay_or_start, synchronous_job_ref

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
OUT_PATH = ARTIFACT_DIR / "executor-submit.json"
POLICY_PATH = ARTIFACT_DIR / "student-sft-epoch1-policy.json"
EXPERIMENT_ID = "P3-nemotron-distillation"
CANDIDATE_ID = "student-sft-epoch1"
ATTEMPT = 1
FIXTURE_SHA256 = "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f"
TRAIN_SHA256 = "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89"
DEV_SHA256 = "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc"
VERIFIER_REVISION = "dd7a9d71f38b40ffbecbbe4a711dd37bfa44d6ce"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_payload(executor: str) -> dict[str, Any]:
    spec = get_model_spec(
        "student-sft",
        "tinker://4346702b-80ed-54e0-9a39-647990764752:train:0/sampler_weights/student-sft-epoch1",
    )
    policy_sha256 = _sha256(POLICY_PATH)
    return {
        "schema_version": "understudy.executor-submit.v1",
        "experiment_id": EXPERIMENT_ID,
        "candidate": {
            "candidate_id": CANDIDATE_ID,
            "executor": executor,
            "model": spec.base_model,
            "model_revision": spec.model_path,
            "policy_ref": "artifact://nemotron-distillation/student-sft-epoch1-policy.json",
            "policy_sha256": policy_sha256,
        },
        "attempt": ATTEMPT,
        "workload": {
            "id": "automationbench-simple-api-offline",
            "dataset_manifest_ref": "artifact://automationbench-simple-api-offline-v1/fixture.json",
            "dataset_manifest_sha256": FIXTURE_SHA256,
            "verifier_environment": "offline AutomationBench evaluator",
            "verifier_revision": VERIFIER_REVISION,
        },
        "splits": {
            "train_manifest_ref": "artifact://automationbench-simple-api-offline-v1/train.json",
            "train_manifest_sha256": TRAIN_SHA256,
            "dev_manifest_ref": "artifact://automationbench-simple-api-offline-v1/dev.json",
            "dev_manifest_sha256": DEV_SHA256,
        },
        "limits": {
            "budget_usd": 100.0,
            "max_concurrent_candidates": 1,
            "max_concurrent_requests_per_candidate": 8,
            "max_rollouts": 390,
            "max_runtime_seconds": 3600,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executor", default="tinker")
    parser.add_argument("--conformance-probe", action="store_true")
    parser.add_argument("--out", default=str(OUT_PATH))
    args = parser.parse_args()
    executor = "fixture" if args.conformance_probe else args.executor
    key, prior = (
        (None, None)
        if args.conformance_probe
        else replay_or_start(EXPERIMENT_ID, CANDIDATE_ID, ATTEMPT)
    )
    output = Path(args.out)
    if prior and output.exists():
        print(json.dumps(prior, sort_keys=True))
        return
    payload = build_payload(executor)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    if key is not None:
        record_completed(
            key,
            EXPERIMENT_ID,
            CANDIDATE_ID,
            ATTEMPT,
            {
                "artifact_ref": f"artifact://nemotron-distillation/{output.name}",
                "job_ref": synchronous_job_ref(key),
                "executor": executor,
            },
        )
    print(json.dumps({"out": str(output), "executor": executor}, sort_keys=True))


if __name__ == "__main__":
    main()
