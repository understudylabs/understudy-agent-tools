from __future__ import annotations

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
