from __future__ import annotations

import json

import pytest

from understudy_agent_tools.route_decision import build_route_decision


def _write_card(path, *, eval_inputs=True, cost=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": "understudy.workload_card.v1",
                "workload_id": "workload-001",
                "source_path": "src/search.py",
                "workload_shape": ["rag"],
                "value_lens": ["quality", "latency", "cost"],
                "baseline": {
                    "provider": "openrouter",
                    "model": "gpt-4o-mini",
                    "latency_ms": None,
                    "input_tokens": 1200,
                    "output_tokens": 200,
                    "cost_usd": cost,
                },
                "data_class": "source-metadata-only",
                "evaluation_inputs": ["evals/search_cases.yaml"] if eval_inputs else [],
                "promotion_gate": None,
                "route_requirements": {
                    "privacy_boundary": "local-only until explicit approval",
                    "tool_calling_required": False,
                    "latency_target_ms": 500,
                },
                "approval_gates": ["running live model calls", "downloading local models"],
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_build_route_decision_packet(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path)

    packet, output = build_route_decision(card_path)

    assert output == tmp_path / ".understudy" / "route-decision" / "route-decision-packet.json"
    assert output.exists()
    assert packet["schema_version"] == "understudy.route_decision_packet.v1"
    assert packet["decision"] == "evaluate-first"
    assert packet["workload_card"] == ".understudy/workload-discovery/workload-card.json"
    assert packet["incumbent"]["provider"] == "openrouter"
    assert packet["constraints"]["data_class"] == "source-metadata-only"
    assert {route["kind"] for route in packet["candidate_routes"]} == {
        "existing-key",
        "local",
        "frontier",
        "understudy",
    }
    assert all(route["external_prior_only"] for route in packet["candidate_routes"])
    assert "quality or savings claims" in packet["caveats"][0]


def test_route_decision_collects_fixtures_first_without_eval_inputs(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path, eval_inputs=False)

    packet, _ = build_route_decision(card_path)

    assert packet["decision"] == "collect-fixtures-first"


def test_route_decision_missing_card_hint(tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match="workload-discovery plan"):
        build_route_decision(tmp_path / ".understudy" / "workload-discovery" / "workload-card.json")
