#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

try:
    from scripts.validate_public_skills import (
        PRODUCTION_URL_PATTERNS,
        RAW_PAYLOAD_PATTERNS,
        SECRET_PATTERNS,
    )
except ModuleNotFoundError:
    from validate_public_skills import (
        PRODUCTION_URL_PATTERNS,
        RAW_PAYLOAD_PATTERNS,
        SECRET_PATTERNS,
    )


FORBIDDEN_MEMBER_PARTS = [
    ".understudy/",
    ".env",
    ".pytest_cache/",
    ".tmp/",
    ".venv/",
    "__pycache__/",
    "docs/skill-comparison-audit.md",
    "docs/skill-externalization-plan.md",
]
FORBIDDEN_TEXT = [
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
    "Super Admin",
    "super-admin",
    "D1 mutation",
    "pool secret",
    "R2 capture envelope",
]
TEXT_EXTENSIONS = {
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
TEXT_SCAN_EXCLUDE = {
    "scripts/package_release_smoke.py",
    "scripts/validate_public_skills.py",
    "tests/test_package_release_smoke.py",
    "tests/test_validate_public_skills.py",
}


def _member_path(raw_name: str) -> str:
    parts = Path(raw_name).parts
    if len(parts) > 1 and parts[0].endswith((".dist-info", ".egg-info")):
        return "/".join(parts)
    if len(parts) > 1 and "-" in parts[0]:
        return "/".join(parts[1:])
    return "/".join(parts)


def _member_name_errors(name: str) -> list[str]:
    normalized = _member_path(name)
    errors = []
    for forbidden in FORBIDDEN_MEMBER_PARTS:
        if forbidden in normalized or normalized.endswith(forbidden):
            errors.append(f"{name}: forbidden packaged path {forbidden!r}")
    return errors


def _text_errors(name: str, data: bytes) -> list[str]:
    normalized = _member_path(name)
    if normalized in TEXT_SCAN_EXCLUDE:
        return []
    if Path(normalized).suffix.lower() not in TEXT_EXTENSIONS:
        return []
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return []

    errors = []
    for term in FORBIDDEN_TEXT:
        if term in text:
            errors.append(f"{name}: contains private release term {term!r}")
    for pattern in [*SECRET_PATTERNS, *RAW_PAYLOAD_PATTERNS, *PRODUCTION_URL_PATTERNS]:
        if pattern.search(text):
            errors.append(f"{name}: contains unsafe text matching {pattern.pattern}")
    return errors


def inspect_archive(path: Path) -> list[str]:
    errors: list[str] = []
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                errors.extend(_member_name_errors(info.filename))
                errors.extend(_text_errors(info.filename, archive.read(info)))
    elif path.suffixes[-2:] == [".tar", ".gz"]:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                errors.extend(_member_name_errors(member.name))
                extracted = archive.extractfile(member)
                if extracted is not None:
                    errors.extend(_text_errors(member.name, extracted.read()))
    else:
        errors.append(f"{path}: unsupported archive type")
    return errors


def build_archives(out_dir: Path) -> list[Path]:
    subprocess.run(
        ["uv", "build", "--out-dir", str(out_dir)],
        check=True,
        cwd=Path.cwd(),
    )
    return sorted([*out_dir.glob("*.whl"), *out_dir.glob("*.tar.gz")])


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and inspect public release archives.")
    parser.add_argument("--dist-dir", type=Path, default=None)
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        dist_dir = args.dist_dir or Path(tmp) / "dist"
        dist_dir.mkdir(parents=True, exist_ok=True)
        archives = sorted([*dist_dir.glob("*.whl"), *dist_dir.glob("*.tar.gz")])
        if not args.skip_build:
            archives = build_archives(dist_dir)
        if not archives:
            print(f"no release archives found in {dist_dir}")
            return 1

        errors: list[str] = []
        for archive in archives:
            errors.extend(inspect_archive(archive))
        for error in errors:
            print(error)
        if errors:
            return 1
        print(f"ok {len(archives)} release archive(s)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
