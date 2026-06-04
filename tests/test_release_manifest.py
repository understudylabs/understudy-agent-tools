from __future__ import annotations

import subprocess
from pathlib import Path


def test_no_runtime_or_private_files_are_tracked() -> None:
    result = subprocess.run(
        ["git", "ls-files"],
        check=True,
        text=True,
        capture_output=True,
    )
    tracked = result.stdout.splitlines()
    forbidden_parts = [
        ".understudy/",
        ".env",
        ".tmp/",
        ".venv/",
        ".pytest_cache/",
        "docs/skill-externalization-plan.md",
        "docs/skill-comparison-audit.md",
    ]

    offenders = [
        path for path in tracked if any(part in path or path.endswith(part) for part in forbidden_parts)
    ]

    assert offenders == []


def test_vendor_manifest_covers_vendor_files() -> None:
    vendor_root = Path("vendor")
    manifest = vendor_root / "MANIFEST.md"
    assert manifest.exists()

    manifest_text = manifest.read_text(encoding="utf-8")
    vendored_files = [
        path for path in vendor_root.rglob("*") if path.is_file() and path.name != "MANIFEST.md"
    ]
    missing = [str(path) for path in vendored_files if str(path) not in manifest_text]

    assert missing == []
