#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$")
NAME = re.compile(r"^[a-z0-9-]+$")
ALLOWED_TOP_LEVEL = {"name", "description", "license", "allowed-tools", "metadata"}
PRIVATE_TERMS = [
    "/Users/luis/",
    "/understudy-agent/",
    "understudy-agent/",
    "understudy-platform",
    "understudy-knowledge",
    "raw-notes",
    "private/runbooks",
    ".smithers",
    "Fullcast",
    "Cedar",
    "Workgrounds",
    "Forecast",
    "Mercado",
    "Meli",
    "Super Admin",
    "super-admin",
    "D1 mutation",
    "pool secret",
    "R2 capture envelope",
]
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
RAW_PAYLOAD_PATTERNS = [
    re.compile(r"\braw_prompt\b", re.IGNORECASE),
    re.compile(r"\braw_completion\b", re.IGNORECASE),
    re.compile(r"\btrace_payload\b", re.IGNORECASE),
]
PRODUCTION_URL_PATTERNS = [
    re.compile(r"https://(?:api|app|admin|dashboard)\.understudy(?:labs)?\."),
]
SCAN_EXTENSIONS = {
    ".json",
    ".jsonl",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
REPO_SCAN_EXCLUDE = {
    Path("scripts/package_release_smoke.py"),
    Path("scripts/validate_public_skills.py"),
    Path("tests/test_package_release_smoke.py"),
    Path("tests/test_validate_public_skills.py"),
}
PUBLIC_DOC_DIRS = ["docs"]


def parse_frontmatter(text: str) -> tuple[dict[str, str], str] | None:
    match = FRONTMATTER.match(text)
    if not match:
        return None
    frontmatter = {}
    lines = match.group(1).splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line[0].isspace():
            i += 1
            continue
        key_match = KEY.match(line)
        if not key_match:
            i += 1
            continue
        key, value = key_match.group(1), key_match.group(2).strip()
        if value in {"", "|", ">"}:
            frontmatter[key] = ""
        else:
            frontmatter[key] = value.strip("\"'")
        i += 1
    return frontmatter, text[match.end() :]


def validate_skill(path: Path) -> list[str]:
    errors: list[str] = []
    skill_md = path / "SKILL.md"
    if not skill_md.exists():
        return [f"{path}: missing SKILL.md"]
    text = skill_md.read_text(encoding="utf-8")
    parsed = parse_frontmatter(text)
    if parsed is None:
        return [f"{skill_md}: missing YAML frontmatter"]
    frontmatter, body = parsed

    extra = sorted(set(frontmatter) - ALLOWED_TOP_LEVEL)
    if extra:
        errors.append(f"{skill_md}: unsupported frontmatter keys: {extra}")

    name = frontmatter.get("name", "")
    if not name or not NAME.match(name):
        errors.append(f"{skill_md}: name must be lowercase hyphen-case")
    elif name != path.name:
        errors.append(f"{skill_md}: name must match directory name")

    description = frontmatter.get("description", "")
    if not description:
        errors.append(f"{skill_md}: missing description")
    if len(description) > 1024:
        errors.append(f"{skill_md}: description exceeds 1024 chars")
    if len(description) > 512:
        errors.append(f"{skill_md}: description should be activation-only; exceeds 512 chars")

    if "## Safety Gates" not in body:
        errors.append(f"{skill_md}: missing ## Safety Gates")
    if "## Resolve CLI" not in body and "cli_required: false" not in text:
        errors.append(f"{skill_md}: missing ## Resolve CLI")

    line_count = len(text.splitlines())
    if line_count > 150 and name != "understudy":
        has_refs = (path / "reference.md").exists() or (path / "references").is_dir()
        if not has_refs:
            errors.append(f"{skill_md}: >150 lines without reference.md or references/")

    for term in PRIVATE_TERMS:
        if term in text:
            errors.append(f"{skill_md}: contains private review term {term!r}")
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            errors.append(f"{skill_md}: contains secret-shaped text matching {pattern.pattern}")

    return errors


def validate_public_text(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8")
    for term in PRIVATE_TERMS:
        if term in text:
            errors.append(f"{path}: contains private review term {term!r}")
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            errors.append(f"{path}: contains secret-shaped text matching {pattern.pattern}")
    for pattern in RAW_PAYLOAD_PATTERNS:
        if pattern.search(text):
            errors.append(f"{path}: contains raw payload marker matching {pattern.pattern}")
    for pattern in PRODUCTION_URL_PATTERNS:
        if pattern.search(text):
            errors.append(f"{path}: contains production/control-plane URL matching {pattern.pattern}")
    return errors


def validate_public_markdown(path: Path) -> list[str]:
    return validate_public_text(path)


def is_gitignored(path: Path) -> bool:
    result = subprocess.run(
        ["git", "check-ignore", "--quiet", str(path)],
        cwd=Path.cwd(),
        check=False,
    )
    return result.returncode == 0


def git_tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=Path.cwd(),
        check=True,
        text=True,
        capture_output=True,
    )
    return [Path(line) for line in result.stdout.splitlines() if line.strip()]


def validate_public_repo() -> list[str]:
    errors: list[str] = []
    for path in git_tracked_files():
        if path in REPO_SCAN_EXCLUDE:
            continue
        if path.suffix.lower() not in SCAN_EXTENSIONS:
            continue
        if not path.exists() or is_gitignored(path):
            continue
        try:
            errors.extend(validate_public_text(path))
        except UnicodeDecodeError:
            continue
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate public Understudy skills and release text.")
    parser.add_argument("paths", nargs="*", default=["skills"])
    parser.add_argument(
        "--docs",
        nargs="*",
        default=PUBLIC_DOC_DIRS,
        help="Markdown doc directories to scan for public-safety terms.",
    )
    parser.add_argument(
        "--repo",
        action="store_true",
        help="Scan every tracked text file for public-release safety patterns.",
    )
    args = parser.parse_args()

    roots = [Path(p) for p in args.paths]
    skill_dirs: list[Path] = []
    for root in roots:
        if (root / "SKILL.md").exists():
            skill_dirs.append(root)
        elif root.is_dir():
            skill_dirs.extend(
                p for p in sorted(root.iterdir()) if p.is_dir() and (p / "SKILL.md").exists()
            )

    all_errors: list[str] = []
    for skill_dir in skill_dirs:
        all_errors.extend(validate_skill(skill_dir))
    for doc_root_arg in args.docs:
        doc_root = Path(doc_root_arg)
        if doc_root.is_file() and doc_root.suffix == ".md":
            if not is_gitignored(doc_root):
                all_errors.extend(validate_public_text(doc_root))
        elif doc_root.is_dir():
            for doc_path in sorted(doc_root.rglob("*.md")):
                if not is_gitignored(doc_path):
                    all_errors.extend(validate_public_text(doc_path))
    if args.repo:
        all_errors.extend(validate_public_repo())

    for error in all_errors:
        print(error)
    if not all_errors:
        print(f"ok {len(skill_dirs)} public skill(s)")
    return 1 if all_errors else 0


if __name__ == "__main__":
    sys.exit(main())
