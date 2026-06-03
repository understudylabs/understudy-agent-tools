#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    required = [
        "README.md",
        "LICENSE",
        "pyproject.toml",
        "skills/understudy/SKILL.md",
        "vendor/MANIFEST.md",
    ]
    missing = [path for path in required if not (root / path).exists()]
    print(
        json.dumps(
            {
                "repo": "understudy-agent-tools",
                "python": sys.version.split()[0],
                "missing": missing,
                "ok": not missing,
            },
            indent=2,
        )
    )
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
