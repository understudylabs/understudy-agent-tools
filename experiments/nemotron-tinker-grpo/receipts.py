"""Tinker billing-usage receipt helpers."""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import tinker
from tinker import ServiceClient as TinkerServiceClient

BASE_URL = os.environ.get(
    "TINKER_BASE_URL",
    "https://tinker.thinkingmachines.dev/services/tinker-prod",
).rstrip("/")
BILLING_USAGE_PATH = "/api/v1/get_billing_usage"


def service_client() -> tinker.ServiceClient:
    api_key = os.environ.get("TINKER_API_KEY")
    if not api_key:
        return TinkerServiceClient()
    # This box's pyqwest transport raised UnknownIssuer; use the working
    # X-Api-Key REST setup and reuse its session instead.
    headers = {"X-Api-Key": api_key}
    with httpx.Client(base_url=BASE_URL, headers=headers, timeout=20.0) as client:
        config = client.post(
            "/api/v1/client/config",
            json={"sdk_version": getattr(tinker, "__version__", "0.23.1")},
        )
        config.raise_for_status()
        client_config = config.json()
        client_config["pjwt_auth_enabled"] = False
        client_config["use_pyqwest_transport"] = False
        session = client.post(
            "/api/v1/create_session",
            json={
                "tags": [],
                "user_metadata": {},
                "sdk_version": getattr(tinker, "__version__", "0.23.1"),
            },
        )
        session.raise_for_status()
        session_id = session.json()["session_id"]
    client = TinkerServiceClient(
        _client_config=client_config,
        session_id=session_id,
    )
    client.holder._sampling_client_counter = 0
    client.holder._training_client_counter = 0
    return client


def _window() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    start = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    end = start + timedelta(hours=2)
    return start.isoformat().replace("+00:00", "Z"), end.isoformat().replace("+00:00", "Z")


def _dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_dump(item) for item in value]
    if isinstance(value, dict):
        return {key: _dump(item) for key, item in value.items()}
    return value


def _snapshot_response(response: Any, starting_on: str, ending_before: str) -> dict[str, Any]:
    return {
        "starting_on": starting_on,
        "ending_before": ending_before,
        "response": _dump(response),
    }


def snapshot_usage(rest_client: Any, starting_on: str | None = None, ending_before: str | None = None) -> dict[str, Any]:
    if starting_on is None or ending_before is None:
        starting_on, ending_before = _window()
    api_key = os.environ.get("TINKER_API_KEY")
    if not api_key:
        return _snapshot_response({}, starting_on, ending_before)
    response = httpx.get(
        f"{BASE_URL}{BILLING_USAGE_PATH}",
        headers={"X-Api-Key": api_key},
        params={"starting_on": starting_on, "ending_before": ending_before},
        timeout=20.0,
    )
    try:
        payload = response.json()
    except ValueError:
        payload = {"text": response.text}
    return {
        "starting_on": starting_on,
        "ending_before": ending_before,
        "endpoint": f"{BASE_URL}{BILLING_USAGE_PATH}",
        "status_code": response.status_code,
        "response": payload,
    }


async def snapshot_usage_async(
    rest_client: Any,
    starting_on: str | None = None,
    ending_before: str | None = None,
) -> dict[str, Any]:
    if starting_on is None or ending_before is None:
        starting_on, ending_before = _window()
    return await asyncio.to_thread(snapshot_usage, rest_client, starting_on, ending_before)


def _event_totals(snapshot: dict[str, Any]) -> dict[str, Any]:
    totals: dict[str, Any] = {}
    for event in snapshot.get("response", {}).get("data", []):
        info = event.get("event_info", {})
        kind = info.get("type", "unknown")
        bucket = totals.setdefault(kind, {"events": 0, "token_count": 0, "count": 0, "gigabyte_hours": 0})
        bucket["events"] += 1
        bucket["token_count"] += info.get("token_count") or 0
        bucket["count"] += info.get("count") or 0
        bucket["gigabyte_hours"] += info.get("gigabyte_hours") or 0
    return totals


def usage_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    before_totals = _event_totals(before)
    after_totals = _event_totals(after)
    delta: dict[str, Any] = {}
    for kind in sorted(set(before_totals) | set(after_totals)):
        old = before_totals.get(kind, {})
        new = after_totals.get(kind, {})
        delta[kind] = {
            field: new.get(field, 0) - old.get(field, 0)
            for field in ("events", "token_count", "count", "gigabyte_hours")
        }
    return delta


def write_receipt(
    rest_client: Any,
    path: str | Path,
    phase: str,
    before: dict[str, Any],
    after: dict[str, Any],
) -> dict[str, Any]:
    receipt = {
        "phase": phase,
        "before": before,
        "after": after,
        "delta": usage_delta(before, after),
    }
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def capture_phase_receipt(rest_client: Any, phase: str, path: str | Path, fn: Any) -> Any:
    starting_on, ending_before = _window()
    before = snapshot_usage(rest_client, starting_on, ending_before)
    try:
        return fn()
    finally:
        after = snapshot_usage(rest_client, starting_on, ending_before)
        write_receipt(rest_client, path, phase, before, after)
