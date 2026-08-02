"""Build and verify the immutable artifact manifest for the P3 arm."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
MANIFEST_PATH = ARTIFACT_DIR / "artifact-manifest.json"
FIXTURE_SHA256 = "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f"
SPLIT_SHA256 = {
    "train": "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89",
    "dev": "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc",
    "holdout": "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _phase_for(name: str) -> str:
    if "entry-gate" in name:
        return "A"
    if "teacher-trajectories" in name:
        return "B1"
    if name.startswith("sft-"):
        return "B2"
    if "dev" in name or "latency-cost" in name or name == "selection.json":
        return "B3/B4"
    if "holdout" in name or "tolerance" in name:
        return "C2-claim-boundary"
    return "C"


def _step_for(name: str) -> str:
    if "entry-gate" in name:
        return "entry_gate"
    if "teacher-trajectories" in name:
        return "teacher_trajectories"
    if name.startswith("sft-"):
        return "sft_student"
    if "warm" in name:
        return "evaluate_warm"
    if "dev" in name:
        return "evaluate_dev"
    if "holdout" in name or "tolerance" in name:
        return "sealed_holdout"
    if name == "events.jsonl":
        return "phase_event_emission"
    if name == "step-ledger.json":
        return "step_ledger"
    return "build_manifest"


def _artifact_entries() -> list[dict[str, Any]]:
    entries = []
    for path in sorted(ARTIFACT_DIR.iterdir()):
        if not path.is_file() or path.name == MANIFEST_PATH.name:
            continue
        entries.append(
            {
                "ref": f"artifact://nemotron-distillation/{path.name}",
                "sha256": _sha256(path),
                "bytes": path.stat().st_size,
                "produced_by_step": _step_for(path.name),
                "phase": _phase_for(path.name),
            }
        )
    return entries


def _manifest() -> dict[str, Any]:
    serving_contracts = json.loads(
        (ARTIFACT_DIR / "serving-contracts.json").read_text()
    )
    return {
        "schema_version": "understudy.distillation_artifact.v1",
        "experiment_id": "P3-nemotron-distillation",
        "candidate_id": "student-sft-epoch1",
        "artifact_refs_only": True,
        "self_reference_excluded": True,
        "artifacts": _artifact_entries(),
        "dataset": {
            "fixture_sha256": FIXTURE_SHA256,
            "split_sha256": SPLIT_SHA256,
            "train_rows": 48,
            "dev_rows": 12,
            "holdout_rows": 12,
        },
        "verifier": {
            "identity": "automationbench-simple-api-offline",
            "revision": FIXTURE_SHA256,
            "service_runtime": "/home/ubuntu/wt-402",
        },
        "model_serving_contracts": serving_contracts,
        "executor": {
            "requested": "tinker",
            "workflow_spec_union": ["modal", "wafer", "fireworks", "spark"],
            "spec_amendment_required": True,
            "limitation": (
                "The Tinker SDK calls used by this arm are blocking and do not "
                "return an async provider job handle; executor_tinker reports "
                "synchronous terminal receipts rather than faking async state."
            ),
        },
        "claim_boundary": {
            "holdout_sealed": True,
            "tolerance_ref": "artifact://nemotron-distillation/holdout-tolerance.json",
            "sealed_runner_ref": "experiment-script://scripts/sealed_holdout.py",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    manifest = _manifest()
    if args.verify:
        if not MANIFEST_PATH.exists():
            raise SystemExit(f"manifest does not exist: {MANIFEST_PATH}")
        existing = json.loads(MANIFEST_PATH.read_text())
        if existing != manifest:
            raise SystemExit("artifact manifest verification failed: hashes or metadata differ")
        print(json.dumps({"verified": True, "artifacts": len(manifest["artifacts"])}))
        return
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"manifest": str(MANIFEST_PATH), "artifacts": len(manifest["artifacts"])}))


if __name__ == "__main__":
    main()
