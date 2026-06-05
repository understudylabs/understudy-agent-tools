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
MVP_PUBLIC_SKILL_NAMES = (
    "understudy",
    "understand-workload",
    "validate-and-optimize",
)
MVP_ROUTER_TARGETS = (
    "../understand-workload/SKILL.md",
    "../validate-and-optimize/SKILL.md",
)
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
SAVINGS_CLAIM_PATTERNS = [
    re.compile(r"\bclaim(?:s|ed|ing)?\s+(?:\w+\s+){0,4}savings\b", re.IGNORECASE),
    re.compile(r"\bsavings\s+claim(?:s|ed|ing)?\b", re.IGNORECASE),
    re.compile(r"\bguarantee(?:s|d|ing)?\s+(?:\w+\s+){0,4}savings\b", re.IGNORECASE),
]
GEPA_HOLDOUT_PATTERNS = [
    re.compile(
        r"\bGEPA\b[^.\n]*(?:may|can|should|must|will|use|uses|using|run|runs|running|tune|tunes|tuning)"
        r"[^.\n]*\bholdout\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bholdout\b[^.\n]*(?:for|with|in|during)[^.\n]*\bGEPA\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bGEPA\b[^.\n]*\b(touch|touches|touching|mutate|mutates|mutating|train|trains|training)"
        r"[^.\n]*\bholdout\b",
        re.IGNORECASE,
    ),
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


def validate_mvp_public_skill_surface(skills_root: Path = Path("skills")) -> list[str]:
    errors: list[str] = []
    for name in MVP_PUBLIC_SKILL_NAMES:
        skill_md = skills_root / name / "SKILL.md"
        if not skill_md.exists():
            errors.append(f"{skill_md}: missing MVP public skill")
    return errors


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
    errors.extend(validate_mvp_skill_contract(path, skill_md, text))

    return errors


def validate_mvp_skill_contract(path: Path, skill_md: Path, text: str) -> list[str]:
    errors: list[str] = []
    name = path.name
    lower_text = text.lower()

    if name == "understudy":
        for target in MVP_ROUTER_TARGETS:
            if target not in text:
                errors.append(f"{skill_md}: MVP router must link to {target}")

    if name.endswith("optimize") or name == "validate-and-optimize":
        if not _has_measured_baseline_gate(lower_text):
            errors.append(f"{skill_md}: optimizer skill must require a measured baseline gate")

    if name == "understand-workload" and _requires_register_auth_before_oss_local_analysis(text):
        errors.append(f"{skill_md}: must not require register/auth before OSS local analysis")

    if name in MVP_PUBLIC_SKILL_NAMES and _has_savings_claim_without_claim_packet(text):
        errors.append(f"{skill_md}: savings claims must require a claim packet")

    if _has_unsafe_gepa_holdout_access(text):
        errors.append(f"{skill_md}: GEPA must not touch holdout data")

    return errors


def _has_measured_baseline_gate(lower_text: str) -> bool:
    gate_words = ("measured", "gate", "before", "required", "require", "do not", "must")
    for match in re.finditer(r"\bbaseline\b", lower_text):
        window = lower_text[max(0, match.start() - 160) : match.end() + 280]
        if any(word in window for word in gate_words):
            return True
    return False


def _requires_register_auth_before_oss_local_analysis(text: str) -> bool:
    paragraphs = re.split(r"\n\s*\n", text.lower())
    for paragraph in paragraphs:
        has_oss = "oss" in paragraph or "open-source" in paragraph
        has_local_analysis = "local analysis" in paragraph or "local analyzer" in paragraph
        has_register_auth = "register" in paragraph and "auth" in paragraph
        has_boundary = "before" in paragraph or "required" in paragraph or "requires" in paragraph
        has_negation = "does not require" in paragraph or "do not require" in paragraph
        if has_oss and has_local_analysis and has_register_auth and has_boundary and not has_negation:
            return True
    return False


def _has_savings_claim_without_claim_packet(text: str) -> bool:
    lower_text = text.lower()
    if "claim packet" in lower_text or "claim.json" in lower_text:
        return False
    for pattern in SAVINGS_CLAIM_PATTERNS:
        for match in pattern.finditer(text):
            window = text[max(0, match.start() - 80) : match.end()].lower()
            if any(negation in window for negation in ("do not", "don't", "never", "must not", "cannot")):
                continue
            return True
    return False


def _has_unsafe_gepa_holdout_access(text: str) -> bool:
    for pattern in GEPA_HOLDOUT_PATTERNS:
        for match in pattern.finditer(text):
            window = text[max(0, match.start() - 80) : match.end()].lower()
            if any(negation in window for negation in ("must not", "do not", "never", "cannot", "may not")):
                continue
            return True
    return False


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
    for root in roots:
        if root.name == "skills" and root.is_dir():
            all_errors.extend(validate_mvp_public_skill_surface(root))
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
