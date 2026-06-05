from __future__ import annotations

from pathlib import Path

from scripts.validate_public_skills import (
    is_gitignored,
    MVP_ROUTER_TARGETS,
    validate_mvp_public_skill_surface,
    validate_public_markdown,
    validate_public_text,
    validate_skill,
)


def write_skill(path: Path, name: str, body: str) -> None:
    path.mkdir()
    (path / "SKILL.md").write_text(
        f"""---
name: {name}
description: Test skill for public validation.
metadata:
  understudy:
    cli_required: true
---

{body}
""",
        encoding="utf-8",
    )


def test_all_public_skills_validate() -> None:
    skill_dirs = sorted(
        path for path in Path("skills").iterdir() if path.is_dir() and (path / "SKILL.md").exists()
    )
    assert skill_dirs
    errors: list[str] = []
    for skill_dir in skill_dirs:
        errors.extend(validate_skill(skill_dir))
    assert errors == []


def test_mvp_public_skill_surface_is_present() -> None:
    assert validate_mvp_public_skill_surface(Path("skills")) == []


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

    missing_from_readme = [name for name in skill_names if name != "understudy" and name not in readme]
    missing_from_router = [target for target in MVP_ROUTER_TARGETS if target not in router]

    assert missing_from_readme == []
    assert missing_from_router == []


def test_public_text_rejects_private_path_and_secret(tmp_path) -> None:
    path = tmp_path / "bad.md"
    path.write_text(
        "Private path /Users/luis/Developer/private-repo and token Bearer abcdefghijklmnopqrstuvwxyz123456",
        encoding="utf-8",
    )

    errors = validate_public_text(path)

    assert any("/Users/luis/" in error for error in errors)
    assert any("secret-shaped" in error for error in errors)


def test_public_text_rejects_raw_payload_markers(tmp_path) -> None:
    path = tmp_path / "bad.md"
    path.write_text("trace_payload should not appear in public release docs", encoding="utf-8")

    errors = validate_public_text(path)

    assert any("raw payload marker" in error for error in errors)


def test_optimizer_skill_rejects_missing_baseline_gate(tmp_path) -> None:
    skill_dir = tmp_path / "validate-and-optimize"
    write_skill(
        skill_dir,
        "validate-and-optimize",
        """# Validate And Optimize

## Safety Gates

Run optimizer experiments and compare candidates. Savings claims require a claim packet.
GEPA must not touch holdout data.

## Resolve CLI

Resolve the Understudy CLI before command execution.
""",
    )

    errors = validate_skill(skill_dir)

    assert any("measured baseline gate" in error for error in errors)


def test_savings_claim_rejects_missing_claim_packet(tmp_path) -> None:
    skill_dir = tmp_path / "validate-and-optimize"
    write_skill(
        skill_dir,
        "validate-and-optimize",
        """# Validate And Optimize

## Safety Gates

Require a measured baseline gate before optimizer work.
Claim savings after comparing candidates.
GEPA must not touch holdout data.

## Resolve CLI

Resolve the Understudy CLI before command execution.
""",
    )

    errors = validate_skill(skill_dir)

    assert any("claim packet" in error for error in errors)


def test_understand_workload_rejects_register_auth_before_oss_local_analysis(tmp_path) -> None:
    skill_dir = tmp_path / "understand-workload"
    write_skill(
        skill_dir,
        "understand-workload",
        """# Understand Workload

## Safety Gates

OSS local analysis requires register and auth before inspecting repo metadata.

## Resolve CLI

Resolve the Understudy CLI before command execution.
""",
    )

    errors = validate_skill(skill_dir)

    assert any("must not require register/auth" in error for error in errors)


def test_gepa_rejects_touching_holdout(tmp_path) -> None:
    skill_dir = tmp_path / "validate-and-optimize"
    write_skill(
        skill_dir,
        "validate-and-optimize",
        """# Validate And Optimize

## Safety Gates

Require a measured baseline gate before optimizer work.
Savings claims require a claim packet.
GEPA may tune prompts on holdout examples.

## Resolve CLI

Resolve the Understudy CLI before command execution.
""",
    )

    errors = validate_skill(skill_dir)

    assert any("GEPA must not touch holdout" in error for error in errors)


def test_release_docs_exist_and_are_linked() -> None:
    required = [
        "docs/privacy-and-data-boundaries.md",
        "docs/security.md",
        "docs/telemetry.md",
        "docs/oss-release-boundary.md",
        "docs/release-checklist.md",
    ]
    readme = Path("README.md").read_text(encoding="utf-8")
    for doc in required:
        assert Path(doc).exists()
        assert doc in readme
