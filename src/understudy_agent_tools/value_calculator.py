from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _load_json(path: Path, label: str, hint: str) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"missing {label}: {path}. {hint}")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _relative_artifact_path(path: Path) -> str:
    parts = path.parts
    if ".understudy" in parts:
        index = parts.index(".understudy")
        return str(Path(*parts[index:]))
    return str(path)


def _number(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    return None


def build_value_report(
    workload_card_path: Path,
    route_decision_path: Path,
    requests_per_month: int | None,
) -> tuple[dict[str, Any], Path]:
    card = _load_json(
        workload_card_path,
        "Workload Card",
        "Run `understudy-tools workload-discovery plan --repo .` first.",
    )
    route_packet = _load_json(
        route_decision_path,
        "Route Decision Packet",
        "Run `understudy-tools route-decision plan --workload-card .understudy/workload-discovery/workload-card.json` first.",
    )
    if card.get("schema_version") != "understudy.workload_card.v1":
        raise ValueError("expected schema_version understudy.workload_card.v1")
    if route_packet.get("schema_version") != "understudy.route_decision_packet.v1":
        raise ValueError("expected schema_version understudy.route_decision_packet.v1")

    baseline = card.get("baseline") if isinstance(card.get("baseline"), dict) else {}
    baseline_cost = _number(baseline.get("cost_usd"))
    baseline_monthly = (
        baseline_cost * requests_per_month
        if baseline_cost is not None and requests_per_month is not None
        else None
    )
    caveats = [
        "Evidence level 1: Workload Card plus route decision only.",
        "No candidate savings, latency, or quality claim is available without measured evaluation evidence.",
    ]
    if requests_per_month is not None and baseline_cost is None:
        caveats.append("missing measured per-request cost")

    report = {
        "schema_version": "understudy.value_report.v1",
        "evidence_level": 1,
        "workload_card": _relative_artifact_path(workload_card_path),
        "route_decision_packet": _relative_artifact_path(route_decision_path),
        "requests_per_month": requests_per_month,
        "decision": "measure-baseline-first",
        "baseline": {
            "provider": baseline.get("provider"),
            "model": baseline.get("model"),
            "cost_usd_per_request": baseline_cost,
            "latency_ms": baseline.get("latency_ms"),
            "input_tokens": baseline.get("input_tokens"),
            "output_tokens": baseline.get("output_tokens"),
            "monthly_cost_usd": baseline_monthly,
        },
        "candidate": {
            "provider": None,
            "model": None,
            "cost_usd_per_request": None,
            "latency_ms": None,
            "quality_delta": None,
            "monthly_cost_usd": None,
        },
        "scenario": {
            "baseline_monthly_cost_usd": baseline_monthly,
            "candidate_monthly_cost_usd": None,
            "monthly_savings_usd": None,
            "latency_delta_ms": None,
            "quality_delta": None,
        },
        "approval_required_before": [
            "live model calls",
            "uploads",
            "hosted jobs",
            "production rollout",
            "public savings claims",
        ],
        "caveats": caveats,
        "recommended_next_command": f"understudy-tools evaluate plan --workload-card {_relative_artifact_path(workload_card_path)} --dry-run",
    }
    output = workload_card_path.parent.parent / "value" / "value-report.json"
    _write_json(output, report)
    return report, output
