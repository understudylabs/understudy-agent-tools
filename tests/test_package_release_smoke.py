from __future__ import annotations

import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

from scripts.package_release_smoke import inspect_archive


def test_inspect_wheel_rejects_runtime_artifact(tmp_path) -> None:
    wheel = tmp_path / "bad-0.1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("bad/.understudy/workload-card.json", "{}")

    errors = inspect_archive(wheel)

    assert any(".understudy/" in error for error in errors)


def test_inspect_sdist_rejects_private_text(tmp_path) -> None:
    sdist = tmp_path / "bad-0.1.0.tar.gz"
    source = tmp_path / "source"
    source.mkdir()
    bad = source / "README.md"
    bad.write_text("Private path /Users/luis/Developer/private-repo", encoding="utf-8")
    with tarfile.open(sdist, "w:gz") as archive:
        archive.add(bad, arcname="bad-0.1.0/README.md")

    errors = inspect_archive(sdist)

    assert any("/Users/luis/" in error for error in errors)


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is required for release archive build smoke")
def test_package_release_smoke_script_builds_clean_archives(tmp_path) -> None:
    result = subprocess.run(
        ["python3", "scripts/package_release_smoke.py", "--dist-dir", str(tmp_path)],
        check=False,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "release archive" in result.stdout
