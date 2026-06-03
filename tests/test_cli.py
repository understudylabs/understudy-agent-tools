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


def test_keys_roadmap_surface(capsys) -> None:
    assert main(["keys", "doctor", "--redacted"]) == 0
    out = capsys.readouterr().out
    assert "keys: planned" in out


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
