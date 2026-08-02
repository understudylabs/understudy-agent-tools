"""Small file-keyed idempotency ledger for experiment phase steps."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
LEDGER_PATH = EXPERIMENT_DIR / "artifacts" / "step-ledger.json"


def idempotency_key(experiment_id: str, candidate_id: str, attempt: int) -> str:
    payload = json.dumps(
        {
            "attempt": attempt,
            "candidate_id": candidate_id,
            "experiment_id": experiment_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def synchronous_job_ref(key: str) -> str:
    return f"tinker://sync/{key}"


def replay_or_start(
    experiment_id: str, candidate_id: str, attempt: int
) -> tuple[str, dict[str, Any] | None]:
    if attempt < 1:
        raise ValueError("attempt must be positive")
    key = idempotency_key(experiment_id, candidate_id, attempt)
    if not LEDGER_PATH.exists():
        return key, None
    ledger = json.loads(LEDGER_PATH.read_text())
    entry = ledger.get("steps", {}).get(key)
    if entry and entry.get("status") == "completed":
        return key, entry.get("result", {})
    return key, None


def record_completed(
    key: str,
    experiment_id: str,
    candidate_id: str,
    attempt: int,
    result: dict[str, Any],
) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    ledger = {"schema_version": "understudy.step_ledger.v1", "steps": {}}
    if LEDGER_PATH.exists():
        ledger = json.loads(LEDGER_PATH.read_text())
    ledger.setdefault("steps", {})[key] = {
        "experiment_id": experiment_id,
        "candidate_id": candidate_id,
        "attempt": attempt,
        "status": "completed",
        "result": result,
    }
    temporary = LEDGER_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, LEDGER_PATH)
