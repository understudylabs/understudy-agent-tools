from __future__ import annotations

from scripts.validate_public_skills import validate_skill


def test_public_skills_validate() -> None:
    errors = validate_skill(__import__("pathlib").Path("skills/understudy"))
    assert errors == []
