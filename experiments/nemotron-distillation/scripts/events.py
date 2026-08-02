"""Append small redacted events for the local experiment run."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

EXPERIMENT_DIR = Path(__file__).resolve().parents[1]
EVENTS_PATH = EXPERIMENT_DIR / "artifacts" / "events.jsonl"


def emit_event(
    kind: str,
    action: str,
    *,
    experiment_id: str = "P3-nemotron-distillation",
    candidate_id: str | None = None,
    attempt: int | None = None,
    **metrics: Any,
) -> None:
    if kind not in {"run", "candidate", "rollout", "score", "usage", "error"}:
        raise ValueError(f"unsupported event kind: {kind}")
    event = {
        "schema_version": "understudy.experiment_event.v1",
        "event_kind": f"{kind}.{action}",
        "experiment_id": experiment_id,
        "candidate_id": candidate_id,
        "attempt": attempt,
        "emitted_at_unix": time.time(),
        "metrics": metrics,
    }
    EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with EVENTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, separators=(",", ":")) + "\n")
