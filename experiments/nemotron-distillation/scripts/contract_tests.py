"""Offline validation for the canonical Workflow executor contracts."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from build_submit_payload import build_payload
from executor_tinker import TinkerExecutor
from jsonschema import Draft202012Validator, FormatChecker

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
CONTRACT_DIR = EXPERIMENT_DIR / "contracts"
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
OUT_PATH = ARTIFACT_DIR / "contract-tests.json"
HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701"
SUBMIT_SCHEMA_SHA256 = (
    "6ff8cfa383ff109d7dfe341e5ae2a4d330a8b298b0e8af51af0f1d3106f462c0"
)


def _schema(name: str) -> dict[str, Any]:
    return json.loads((CONTRACT_DIR / name).read_text())


def _errors(instance: Any, schema_name: str) -> list[str]:
    validator = Draft202012Validator(
        _schema(schema_name), format_checker=FormatChecker()
    )
    return [error.message for error in validator.iter_errors(instance)]


def _validate(instance: Any, schema_name: str) -> None:
    errors = _errors(instance, schema_name)
    if errors:
        raise AssertionError(f"{schema_name}: {errors}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def main() -> None:
    real_payload = build_payload("tinker")
    probe_payload = build_payload("fixture")
    real_payload_errors = _errors(
        real_payload, "experiment-executor-submit-request.json"
    )
    probe_payload_errors = _errors(
        probe_payload, "experiment-executor-submit-request.json"
    )
    assert probe_payload_errors == []
    assert any(
        "'tinker' is not one of ['modal', 'wafer', 'fireworks', 'spark', 'fixture']"
        in error
        for error in real_payload_errors
    ), real_payload_errors

    serialized = json.dumps(real_payload, sort_keys=True)
    assert HOLDOUT_SHA256 not in serialized
    assert "holdout" not in serialized.lower()

    result = json.loads((ARTIFACT_DIR / "experiment-result.json").read_text())
    _validate(result, "experiment-result.json")
    result_serialized = json.dumps(result, sort_keys=True)
    assert result["split_manifest_sha256"]["holdout"] == HOLDOUT_SHA256
    assert HOLDOUT_SHA256 in result_serialized
    assert "holdout" in result_serialized.lower()

    executor = TinkerExecutor()
    fixture_job = executor.job_ref(
        experiment_id="P3-nemotron-distillation",
        candidate_id="student-sft-epoch1",
        attempt=1,
        executor="fixture",
    )
    fixture_status = executor.job_status(fixture_job["job_id"])
    fixture_cancel = executor.cancel(fixture_job["job_id"], executor="fixture")
    usage_unknown = executor.reconcile_usage(fixture_job["job_id"])
    with NamedTemporaryFile(
        mode="w", dir=ARTIFACT_DIR, suffix=".contract-receipt.json", delete=False
    ) as handle:
        json.dump({"response": {"data": [{"event_info": {"type": "tokens"}}]}}, handle)
        receipt_path = handle.name
    try:
        usage_account_window = executor.reconcile_usage(
            fixture_job["job_id"], receipt_path
        )
    finally:
        Path(receipt_path).unlink()

    _validate(fixture_job, "experiment-executor-job-ref.json")
    _validate(fixture_status, "experiment-executor-job-status.json")
    _validate(fixture_cancel, "experiment-executor-cancellation-receipt.json")
    _validate(usage_unknown, "experiment-executor-usage-receipt.json")
    _validate(usage_account_window, "experiment-executor-usage-receipt.json")
    assert usage_unknown["evidence_scope"] == "unknown"
    assert usage_account_window["evidence_scope"] == "account_window"
    assert all(
        usage_unknown[field] is None
        for field in ("actual_usd", "estimated_usd", "upper_bound_usd")
    )
    assert fixture_cancel["disposition"] == "already_terminal"

    real_job = executor.job_ref(
        experiment_id="P3-nemotron-distillation",
        candidate_id="student-sft-epoch1",
        attempt=1,
    )
    real_job_errors = _errors(
        real_job, "experiment-executor-job-ref.json"
    )
    real_cancel_errors = _errors(
        executor.cancel(real_job["job_id"]),
        "experiment-executor-cancellation-receipt.json",
    )
    assert any("'tinker' is not one of" in error for error in real_job_errors)
    assert any("'tinker' is not one of" in error for error in real_cancel_errors)

    provenance = json.loads((CONTRACT_DIR / "provenance.json").read_text())
    assert provenance["source_commit"] == "c299ca4"
    assert (
        provenance["files"]["experiment-executor-submit-request.json"]
        == SUBMIT_SCHEMA_SHA256
    )
    assert "experiment-run-status-response.json" in provenance["files"]
    provenance_errors: dict[str, str] = {}
    for name, expected in provenance["files"].items():
        path = CONTRACT_DIR / name
        if not path.exists():
            provenance_errors[name] = "missing"
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            provenance_errors[name] = "sha256 mismatch"
    assert not provenance_errors, provenance_errors

    result = {
        "schema_version": "understudy.distillation_contract_tests.v1",
        "canonical_commit": provenance["source_commit"],
        "submit": {
            "real_executor": "tinker",
            "real_validation": "FAIL",
            "real_errors": real_payload_errors,
            "conformance_probe_executor": "fixture",
            "conformance_probe_validation": "PASS",
        },
        "real_tinker_job_ref_validation": {
            "result": "FAIL_ENUM",
            "errors": real_job_errors,
        },
        "real_tinker_cancellation_validation": {
            "result": "FAIL_ENUM",
            "errors": real_cancel_errors,
        },
        "holdout_absence": {
            "holdout_sha256_present": False,
            "holdout_substring_present": False,
            "assertion": "PASS",
        },
        "result_holdout_binding": {
            "holdout_sha256": result["split_manifest_sha256"]["holdout"],
            "assertion": "PASS",
        },
        "receipts": {
            "job_ref": "PASS",
            "job_status": "PASS",
            "cancellation": "PASS",
            "cancellation_disposition": "already_terminal",
            "real_tinker_cancellation_validation": "FAIL_ENUM",
            "usage_empty_evidence_scope": "unknown",
            "usage_nonempty_evidence_scope": "account_window",
            "dollar_fields": None,
        },
        "enum_blocker": (
            "Blocking amendment: add 'tinker' to the executor union in "
            "experiment-executor-submit-request.json, "
            "experiment-executor-job-ref.json, and "
            "experiment-executor-cancellation-receipt.json."
        ),
        "provider_calls": 0,
        "api_key_present": bool(os.environ.get("TINKER_API_KEY")),
        "observed_at": _now(),
    }
    OUT_PATH.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"out": str(OUT_PATH), "provider_calls": 0}, sort_keys=True))


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
