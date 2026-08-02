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
    if name in {
        "contract-tests.json",
        "executor-submit.json",
        "experiment-result.json",
        "executor-cancellation.json",
        "student-sft-epoch1-policy.json",
    } or name.endswith(".json") and name in {"provenance.json"}:
        return "E-contracts"
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
    if name == "contract-tests.json":
        return "contract_tests"
    if name == "executor-submit.json":
        return "build_submit_payload"
    if name == "experiment-result.json":
        return "build_experiment_result"
    if name == "executor-cancellation.json":
        return "build_experiment_result"
    if name == "student-sft-epoch1-policy.json":
        return "build_submit_payload"
    if name == "provenance.json":
        return "vendor_canonical_contracts"
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
    provenance = json.loads((EXPERIMENT_DIR / "contracts" / "provenance.json").read_text())
    canonical_commit = provenance["source_commit"]
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
            "revision": "dd7a9d71f38b40ffbecbbe4a711dd37bfa44d6ce",
            "service_runtime": "/home/ubuntu/wt-402",
        },
        "model_serving_contracts": serving_contracts,
        "executor": {
            "requested": "tinker",
            "workflow_spec_union": ["modal", "wafer", "fireworks", "spark"],
            "spec_amendment_required": True,
            "canonical_submit_schema": "understudy.executor-submit.v1",
            "limitation": (
                "The Tinker SDK calls used by this arm are blocking and do not "
                "return an async provider job handle; executor_tinker reports "
                "synchronous terminal receipts rather than faking async state."
            ),
        },
        "submit_contract": {
            "payload_ref": "artifact://nemotron-distillation/executor-submit.json",
            "policy_ref": "artifact://nemotron-distillation/student-sft-epoch1-policy.json",
            "canonical_commit": canonical_commit,
            "provenance_ref": "artifact://nemotron-distillation/provenance.json",
            "holdout_absence_assertion": (
                "serialized submit payload contains neither the frozen holdout "
                "hash nor the substring 'holdout'"
            ),
            "enum_blocker": (
                "Add 'tinker' to the executor union in "
                "experiment-executor-submit-request.json, "
                "experiment-executor-job-ref.json, and "
                "experiment-executor-cancellation-receipt.json."
            ),
        },
        "result_contract": {
            "schema": "understudy.experiment-result.v1",
            "result_ref": "artifact://nemotron-distillation/experiment-result.json",
            "holdout_binding": {
                "included": True,
                "sha256": SPLIT_SHA256["holdout"],
                "reason": (
                    "Terminal results bind the sealed holdout; submit payloads "
                    "remain structurally holdout-free."
                ),
            },
            "holdout_clean_reading": (
                "true means the single authorized holdout execution occurred "
                "after the committed predeclaration with no prior access."
            ),
            "request_isolation_proven": False,
            "quality_evidence_status": "measured",
            "quality_evidence_reading": (
                "Metrics are measured and verifier-checked, but the fixture is "
                "saturated and cannot discriminate the compared models."
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
