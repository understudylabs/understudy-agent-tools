"""Thin executor facade for the blocking Tinker SDK calls used by this arm."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from step_runtime import idempotency_key, synchronous_job_ref

LIMITATION = (
    "Tinker SDK operations used by this arm are blocking and expose no async "
    "provider job handle. submit therefore returns a synchronous terminal "
    "receipt and never fabricates an asynchronous job state."
)


def _job_ref(experiment_id: str, candidate_id: str, attempt: int) -> str:
    key = idempotency_key(experiment_id, candidate_id, attempt)
    return synchronous_job_ref(key)


class TinkerExecutor:
    """Implements submit, inspect, cancel, and reconcile_usage locally."""

    def submit(
        self,
        *,
        experiment_id: str,
        candidate_id: str,
        attempt: int,
        operation: str,
        artifact_ref: str,
    ) -> dict[str, Any]:
        return {
            "job_ref": _job_ref(experiment_id, candidate_id, attempt),
            "status": "terminal",
            "terminal": True,
            "execution_mode": "synchronous",
            "operation": operation,
            "artifact_ref": artifact_ref,
            "submitted_at_unix": time.time(),
            "limitation": LIMITATION,
        }

    def inspect(self, job_ref: str) -> dict[str, Any]:
        return {
            "job_ref": job_ref,
            "status": "terminal",
            "terminal": True,
            "execution_mode": "synchronous",
            "limitation": LIMITATION,
        }

    def cancel(self, job_ref: str) -> dict[str, Any]:
        return {
            "job_ref": job_ref,
            "status": "not_cancellable_after_terminal_submission",
            "cancelled": False,
            "limitation": LIMITATION,
        }

    def reconcile_usage(
        self, job_ref: str, receipt_path: str | None = None
    ) -> dict[str, Any]:
        receipt: Any = None
        if receipt_path:
            receipt = json.loads(Path(receipt_path).read_text())
        return {
            "job_ref": job_ref,
            "status": "reconciled",
            "usage": receipt,
            "cost": {"usd": None, "basis": "tinker_billing_usage"},
            "limitation": LIMITATION,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
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
    executor = TinkerExecutor()
    if args.method == "submit":
        result = executor.submit(
            experiment_id=args.experiment_id,
            candidate_id=args.candidate_id,
            attempt=args.attempt,
            operation=args.operation,
            artifact_ref=args.artifact_ref,
        )
    elif args.method == "inspect":
        result = executor.inspect(args.job_ref)
    elif args.method == "cancel":
        result = executor.cancel(args.job_ref)
    else:
        result = executor.reconcile_usage(args.job_ref, args.receipt)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
