"""Canonical contract facade for the blocking Tinker adapter."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from step_runtime import idempotency_key, synchronous_job_ref

LIMITATION = (
    "Tinker SDK operations used by this arm are blocking and expose no async "
    "provider job handle; submit returns a synchronous terminal receipt."
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _job(executor: str, key: str, submitted_at: str) -> dict[str, Any]:
    return {
        "executor": executor,
        "job_id": synchronous_job_ref(key),
        "idempotency_key": key,
        "submitted_at": submitted_at,
    }


def _key_from_job_ref(job_ref: str) -> str:
    prefix = "tinker://sync/"
    if not job_ref.startswith(prefix):
        raise ValueError(f"unsupported synchronous job ref: {job_ref}")
    key = job_ref[len(prefix) :]
    if not key:
        raise ValueError("job ref has no idempotency key")
    return key


def _usage_response(receipt: dict[str, Any] | None) -> dict[str, Any]:
    if not receipt:
        return {}
    response = receipt.get("response")
    if isinstance(response, dict):
        return response
    after = receipt.get("after")
    if isinstance(after, dict) and isinstance(after.get("response"), dict):
        return after["response"]
    return {}


class TinkerExecutor:
    """Emit canonical objects while preserving truthful Tinker limitations."""

    def job_ref(
        self,
        *,
        experiment_id: str,
        candidate_id: str,
        attempt: int,
        executor: str = "tinker",
    ) -> dict[str, Any]:
        return _job(
            executor,
            idempotency_key(experiment_id, candidate_id, attempt),
            _now(),
        )

    def submit(
        self,
        *,
        experiment_id: str,
        candidate_id: str,
        attempt: int,
        operation: str,
        artifact_ref: str,
        executor: str = "tinker",
    ) -> dict[str, Any]:
        del operation, artifact_ref
        return self.job_ref(
            experiment_id=experiment_id,
            candidate_id=candidate_id,
            attempt=attempt,
            executor=executor,
        )

    def job_status(self, job_ref: str) -> dict[str, Any]:
        _key_from_job_ref(job_ref)
        return {
            "state": "succeeded",
            "observed_at": _now(),
            "artifact_refs": [],
        }

    def inspect(self, job_ref: str) -> dict[str, Any]:
        return self.job_status(job_ref)

    def cancel(
        self,
        job_ref: str,
        *,
        executor: str = "tinker",
    ) -> dict[str, Any]:
        key = _key_from_job_ref(job_ref)
        return {
            "job": _job(executor, key, _now()),
            "disposition": "already_terminal",
            "observed_at": _now(),
        }

    def reconcile_usage(
        self,
        job_ref: str,
        receipt_path: str | None = None,
    ) -> dict[str, Any]:
        _key_from_job_ref(job_ref)
        receipt = (
            json.loads(Path(receipt_path).read_text()) if receipt_path else None
        )
        response = _usage_response(receipt)
        evidence_scope = "account_window" if response.get("data") else "unknown"
        return {
            "evidence_scope": evidence_scope,
            "requests": None,
            "input_tokens": None,
            "output_tokens": None,
            "actual_usd": None,
            "estimated_usd": None,
            "upper_bound_usd": None,
            "observed_at": _now(),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--conformance-probe", action="store_true")
    subparsers = parser.add_subparsers(dest="method", required=True)
    submit = subparsers.add_parser("submit")
    submit.add_argument("--experiment-id", required=True)
    submit.add_argument("--candidate-id", required=True)
    submit.add_argument("--attempt", type=int, required=True)
    submit.add_argument("--operation", required=True)
    submit.add_argument("--artifact-ref", required=True)
    inspect = subparsers.add_parser("inspect")
    inspect.add_argument("--job-ref", required=True)
    cancel = subparsers.add_parser("cancel")
    cancel.add_argument("--job-ref", required=True)
    usage = subparsers.add_parser("reconcile_usage")
    usage.add_argument("--job-ref", required=True)
    usage.add_argument("--receipt")
    args = parser.parse_args()
    executor_name = "fixture" if args.conformance_probe else "tinker"
    executor = TinkerExecutor()
    if args.method == "submit":
        result = executor.submit(
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            operation=args.operation,
            artifact_ref=args.artifact_ref,
            executor=executor_name,
        )
    elif args.method == "inspect":
        result = executor.job_status(args.job_ref)
    elif args.method == "cancel":
        result = executor.cancel(args.job_ref, executor=executor_name)
    else:
        result = executor.reconcile_usage(args.job_ref, args.receipt)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
