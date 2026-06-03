from __future__ import annotations

from pathlib import Path

from scripts.validate_public_skills import is_gitignored, validate_public_markdown, validate_skill


def test_all_public_skills_validate() -> None:
    skill_dirs = sorted(
        path for path in Path("skills").iterdir() if path.is_dir() and (path / "SKILL.md").exists()
    )
    assert skill_dirs
    errors: list[str] = []
    for skill_dir in skill_dirs:
        errors.extend(validate_skill(skill_dir))
    assert errors == []


def test_public_markdown_safety_scan() -> None:
    paths = [Path("README.md"), Path("AGENTS.md"), Path("skills/README.md")]
    paths.extend(sorted(Path("docs").glob("*.md")))
    errors: list[str] = []
    for path in paths:
        if path.exists() and not is_gitignored(path):
            errors.extend(validate_public_markdown(path))
    assert errors == []


def test_skill_index_and_router_coverage() -> None:
    skill_names = sorted(
        path.name for path in Path("skills").iterdir() if path.is_dir() and (path / "SKILL.md").exists()
    )
    readme = Path("skills/README.md").read_text(encoding="utf-8")
    router = Path("skills/understudy/SKILL.md").read_text(encoding="utf-8")
    intentionally_nested = {
        "understudy-bootstrap",
    }

    missing_from_readme = [name for name in skill_names if name != "understudy" and name not in readme]
    missing_from_router = [
        name
        for name in skill_names
        if name not in {"understudy"} | intentionally_nested and f"../{name}/SKILL.md" not in router
    ]

    assert missing_from_readme == []
    assert missing_from_router == []
