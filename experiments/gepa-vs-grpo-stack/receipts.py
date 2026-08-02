"""Tinker billing-usage receipt helpers."""

from __future__ import annotations

import json
import asyncio
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import tinker


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
    if hasattr(rest_client, "get_billing_usage"):
        response = rest_client.get_billing_usage(starting_on, ending_before).result()
    else:
        response = _billing_usage_http(starting_on, ending_before)
    return _snapshot_response(response, starting_on, ending_before)


async def snapshot_usage_async(
    rest_client: Any,
    starting_on: str | None = None,
    ending_before: str | None = None,
) -> dict[str, Any]:
    if starting_on is None or ending_before is None:
        starting_on, ending_before = _window()
    response = await asyncio.to_thread(snapshot_usage, rest_client, starting_on, ending_before)
    return response


def _billing_usage_http(starting_on: str, ending_before: str) -> dict[str, Any]:
    api_key = os.environ.get("TINKER_API_KEY")
    if not api_key:
        raise RuntimeError("TINKER_API_KEY is not set")
    query = urllib.parse.urlencode(
        {"starting_on": starting_on, "ending_before": ending_before}
    )
    request = urllib.request.Request(
        "https://tinker.thinkingmachines.dev/services/tinker-prod/api/v1/billing/usage/events"
        f"?{query}",
        headers={"X-Api-Key": api_key},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


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
