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
