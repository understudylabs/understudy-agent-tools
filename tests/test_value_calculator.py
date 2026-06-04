from __future__ import annotations

import json

import pytest

from understudy_agent_tools.route_decision import build_route_decision
from understudy_agent_tools.value_calculator import build_value_report


def _write_card(path, *, cost=None) -> None:
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
                "evaluation_inputs": ["evals/search_cases.yaml"],
                "promotion_gate": None,
                "route_requirements": {},
                "approval_gates": ["running live model calls"],
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_value_report_refuses_savings_without_candidate_evidence(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path)
    _, route_path = build_route_decision(card_path)

    report, output = build_value_report(card_path, route_path, 10_000)

    assert output == tmp_path / ".understudy" / "value" / "value-report.json"
    assert output.exists()
    assert report["schema_version"] == "understudy.value_report.v1"
    assert report["evidence_level"] == 1
    assert report["decision"] == "measure-baseline-first"
    assert report["scenario"]["monthly_savings_usd"] is None
    assert report["candidate"]["quality_delta"] is None
    assert "missing measured per-request cost" in report["caveats"]
    assert "evaluate plan" in report["recommended_next_command"]


def test_value_report_computes_only_measured_baseline_monthly_cost(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path, cost=0.012)
    _, route_path = build_route_decision(card_path)

    report, _ = build_value_report(card_path, route_path, 10_000)

    assert report["baseline"]["monthly_cost_usd"] == pytest.approx(120.0)
    assert report["scenario"]["baseline_monthly_cost_usd"] == pytest.approx(120.0)
    assert report["scenario"]["candidate_monthly_cost_usd"] is None
    assert report["scenario"]["monthly_savings_usd"] is None


def test_value_report_missing_route_decision_hint(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path)

    with pytest.raises(FileNotFoundError, match="route-decision plan"):
        build_value_report(
            card_path,
            tmp_path / ".understudy" / "route-decision" / "route-decision-packet.json",
            None,
        )


def test_value_report_scenario_overrides_are_labeled(tmp_path) -> None:
    card_path = tmp_path / ".understudy" / "workload-discovery" / "workload-card.json"
    _write_card(card_path)
    _, route_path = build_route_decision(card_path)
    output_path = tmp_path / "custom" / "value.json"

    report, output = build_value_report(
        card_path,
        route_path,
        10_000,
        overrides={
            "baseline_cost_usd": 0.012,
            "baseline_latency_ms": 900.0,
            "candidate_cost_usd": 0.004,
            "candidate_latency_ms": 300.0,
        },
        output_path=output_path,
    )

    assert output == output_path
    assert output.exists()
    assert report["scenario_basis"] == "override"
    assert report["decision"] == "evaluate-scenario-first"
    assert report["scenario"]["baseline_monthly_cost_usd"] == pytest.approx(120.0)
    assert report["scenario"]["candidate_monthly_cost_usd"] == pytest.approx(40.0)
    assert report["scenario"]["monthly_savings_usd"] == pytest.approx(80.0)
    assert report["scenario"]["latency_delta_ms"] == pytest.approx(600.0)
    assert any("scenario override only" in caveat for caveat in report["caveats"])
