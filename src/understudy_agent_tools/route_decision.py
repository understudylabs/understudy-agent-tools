from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(
            f"missing Workload Card: {path}. Run `understudy-tools workload-discovery plan --repo .` first."
        )
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


def _local_route_allowed(workload_shape: list[str], route_requirements: dict[str, Any]) -> bool:
    if "multimodal" in workload_shape:
        return False
    return not bool(route_requirements.get("tool_calling_required"))


def build_route_decision(workload_card_path: Path) -> tuple[dict[str, Any], Path]:
    card = _load_json(workload_card_path)
    if card.get("schema_version") != "understudy.workload_card.v1":
        raise ValueError("expected schema_version understudy.workload_card.v1")

    baseline = card.get("baseline") if isinstance(card.get("baseline"), dict) else {}
    route_requirements = (
        card.get("route_requirements") if isinstance(card.get("route_requirements"), dict) else {}
    )
    workload_shape = card.get("workload_shape") if isinstance(card.get("workload_shape"), list) else []
    evaluation_inputs = card.get("evaluation_inputs") if isinstance(card.get("evaluation_inputs"), list) else []
    approval_gates = card.get("approval_gates") if isinstance(card.get("approval_gates"), list) else []
    card_ref = _relative_artifact_path(workload_card_path)

    candidate_routes: list[dict[str, Any]] = []
    provider = baseline.get("provider")
    model = baseline.get("model")
    if provider or model:
        candidate_routes.append(
            {
                "route_id": "route-001",
                "kind": "existing-key",
                "provider": provider,
                "model": model,
                "why_try": "Measure the incumbent or configured route before changing providers.",
                "approval_required": True,
                "approval_reason": "existing keys do not imply approval for live calls",
                "pricing_source": None,
                "supplier_profile": None,
                "external_prior_only": True,
            }
        )

    if _local_route_allowed([str(item) for item in workload_shape], route_requirements):
        candidate_routes.append(
            {
                "route_id": f"route-{len(candidate_routes) + 1:03d}",
                "kind": "local",
                "provider": "local-runner",
                "model": None,
                "why_try": "Local smoke can test privacy, latency, and zero provider-spend feasibility.",
                "approval_required": True,
                "approval_reason": "model downloads require explicit approval",
                "pricing_source": None,
                "supplier_profile": "docs/model-supplier-profiles.md#local-runner",
                "external_prior_only": True,
            }
        )

    candidate_routes.append(
        {
            "route_id": f"route-{len(candidate_routes) + 1:03d}",
            "kind": "frontier",
            "provider": None,
            "model": None,
            "why_try": "Use as a capped live baseline only after local dry-run artifacts are reviewed.",
            "approval_required": True,
            "approval_reason": "frontier calls can send workload data and incur spend",
            "pricing_source": None,
            "supplier_profile": None,
            "external_prior_only": True,
        }
    )
    candidate_routes.append(
        {
            "route_id": f"route-{len(candidate_routes) + 1:03d}",
            "kind": "understudy",
            "provider": "understudy",
            "model": None,
            "why_try": "Evaluate through Understudy after local dry-run when route setup time matters.",
            "approval_required": True,
            "approval_reason": "hosted inference requires explicit spend and data-boundary approval",
            "pricing_source": None,
            "supplier_profile": None,
            "external_prior_only": True,
        }
    )

    decision = "evaluate-first" if evaluation_inputs else "collect-fixtures-first"
    packet = {
        "schema_version": "understudy.route_decision_packet.v1",
        "workload_card": card_ref,
        "decision": decision,
        "incumbent": {
            "provider": provider,
            "model": model,
            "known_latency_ms": baseline.get("latency_ms"),
            "known_cost_usd": baseline.get("cost_usd"),
        },
        "constraints": {
            "workload_shape": workload_shape,
            "privacy_boundary": route_requirements.get(
                "privacy_boundary", "local-only until explicit approval"
            ),
            "data_class": card.get("data_class"),
            "context_budget_tokens": route_requirements.get("context_budget_tokens"),
            "latency_target_ms": route_requirements.get("latency_target_ms"),
            "quality_gate": card.get("promotion_gate"),
            "value_lens": card.get("value_lens", []),
        },
        "readiness": {
            "local_runner_fit": "possible" if any(route["kind"] == "local" for route in candidate_routes) else "blocked-by-workload-shape",
            "provider_keys_redacted": [],
            "supplier_profiles_checked": [],
            "pricing_sources_checked": [],
            "artificial_analysis_snapshots": [],
        },
        "candidate_routes": candidate_routes,
        "recommended_next_command": f"understudy-tools evaluate plan --workload-card {card_ref} --dry-run",
        "approval_required_before": approval_gates
        or ["live model calls", "model downloads", "uploads", "hosted jobs"],
        "caveats": [
            "Route candidates are planning stubs, not quality or savings claims.",
            "External priors do not replace workload-specific evaluation.",
        ],
    }
    output = workload_card_path.parent.parent / "route-decision" / "route-decision-packet.json"
    _write_json(output, packet)
    return packet, output
