from __future__ import annotations

import json

from understudy_agent_tools.cli import main


def test_spine_command(capsys) -> None:
    assert main(["spine"]) == 0
    out = capsys.readouterr().out
    assert "understudy-agent-tools" in out
    assert "skills/understudy/SKILL.md" in out


def test_skills_command(capsys) -> None:
    assert main(["skills"]) == 0
    out = capsys.readouterr().out
    assert "skills/understudy" in out
    assert "skills/understudy-workload-discovery" in out


def test_roadmap_surface_status(capsys) -> None:
    assert main(["evaluate", "status", "--local"]) == 0
    out = capsys.readouterr().out
    assert "evaluate: planned" in out
    assert "docs/tool-migration-map.md" in out


def test_local_models_roadmap_surface(capsys) -> None:
    assert main(["local-models", "doctor", "--local", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "local-models: planned" in out
    assert "skills/understudy-local-models/SKILL.md" in out


def test_provider_integrations_roadmap_surface(capsys) -> None:
    assert main(["provider-integrations", "status"]) == 0
    out = capsys.readouterr().out
    assert "provider-integrations: planned" in out
    assert "skills/understudy-provider-integrations/SKILL.md" in out


def test_keys_roadmap_surface(capsys) -> None:
    assert main(["keys", "doctor", "--redacted"]) == 0
    out = capsys.readouterr().out
    assert "keys: planned" in out


def test_route_decision_and_value_commands(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "search.py").write_text(
        """
SYSTEM_PROMPT = "rank search results"
model = "gpt-4o-mini"
provider = "openrouter"
latency_budget_ms = 500
input_tokens = 1200
""",
        encoding="utf-8",
    )

    assert main(["workload-discovery", "scan", "--repo", str(repo)]) == 0
    capsys.readouterr()
    assert main(["workload-discovery", "plan", "--repo", str(repo)]) == 0
    capsys.readouterr()

    card_path = repo / ".understudy" / "workload-discovery" / "workload-card.json"
    assert main(["route-decision", "plan", "--workload-card", str(card_path)]) == 0
    route_out = capsys.readouterr().out
    assert "decision:" in route_out

    route_path = repo / ".understudy" / "route-decision" / "route-decision-packet.json"
    assert main(
        [
            "value",
            "report",
            "--workload-card",
            str(card_path),
            "--route-decision",
            str(route_path),
            "--requests-per-month",
            "10000",
        ]
    ) == 0
    value_out = capsys.readouterr().out
    assert "savings: not claimed" in value_out


def test_demo_scan_and_plan(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    source = repo / "search.py"
    source.write_text(
        """
SYSTEM_PROMPT = "rank search results"
model = "gpt-4o-mini"
provider = "openrouter"
latency_budget_ms = 500
input_tokens = 1200
""",
        encoding="utf-8",
    )

    assert main(["demo", "scan", "--repo", str(repo)]) == 0
    scan_out = capsys.readouterr().out
    assert "found 1 workload candidate" in scan_out

    candidates_path = repo / ".understudy" / "workload-discovery" / "workload-candidates.json"
    payload = json.loads(candidates_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "understudy.workload_candidates.v1"
    assert payload["repo"]["path"] == "."
    assert payload["candidates"][0]["path"] == "search.py"
    assert "openrouter" in payload["candidates"][0]["providers"]

    assert main(["demo", "plan", "--repo", str(repo)]) == 0
    plan_out = capsys.readouterr().out
    assert "planned candidate-001" in plan_out
    card_path = repo / ".understudy" / "workload-discovery" / "workload-card.json"
    card = json.loads(card_path.read_text(encoding="utf-8"))
    assert card["schema_version"] == "understudy.workload_card.v1"
    assert card["baseline"]["provider"] == "openrouter"
    assert card["data_class"] == "source-metadata-only"
    assert card["split_boundary"] == {"train": None, "dev": None, "holdout": None}
    assert "running live model calls" in card["approval_gates"]


def test_workload_discovery_alias(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "agent.ts").write_text(
        'const model = "gemini-2.5-pro"; const prompt = "summarize"; const provider = "gemini";',
        encoding="utf-8",
    )

    assert main(["workload-discovery", "scan", "--repo", str(repo)]) == 0
    out = capsys.readouterr().out
    assert "candidate-001" in out

    assert main(["workload-discovery", "plan", "--repo", str(repo)]) == 0
    plan_out = capsys.readouterr().out
    assert "planned candidate-001" in plan_out
    card = json.loads(
        (repo / ".understudy" / "workload-discovery" / "workload-card.json").read_text(
            encoding="utf-8"
        )
    )
    assert "route_requirements" in card
    assert "general-llm" not in card["workload_shape"]


def test_capture_import_scan_metadata_only(tmp_path, capsys) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "evals.jsonl").write_text(
        '{"input":"synthetic request","expected":"synthetic answer","latency_ms":900}\n',
        encoding="utf-8",
    )
    (repo / "client.py").write_text(
        'provider = "openai"\nmodel = "gpt-4o-mini"\nSYSTEM_PROMPT = "Use synthetic examples only."\n',
        encoding="utf-8",
    )

    assert main(["capture-import", "scan", "--repo", str(repo)]) == 0
    out = capsys.readouterr().out
    assert "capture/import source candidate" in out

    payload_path = repo / ".understudy" / "capture-import" / "capture-sources.json"
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "understudy.capture_sources.v1"
    assert payload["mode"] == "local-only"
    assert len(payload["sources"]) == 2
    assert all(source["data_class"] == "metadata-only" for source in payload["sources"])
    assert all(source["approval_required_before_payload_read"] for source in payload["sources"])
