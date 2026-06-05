#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

from _common import validate_gate, write_json


INSTALL_HINTS = [
    "uv pip install 'gepa>=0.0.27,<0.1'",
    "python3 -m venv .venv && . .venv/bin/activate && pip install 'gepa>=0.0.27,<0.1'",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="GEPA run gate for validate-and-optimize.")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--artifact-root", default=None, help="Artifact root relative to repo; defaults to .understudy/understand-workload.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--budget-usd", type=float, default=None)
    parser.add_argument("--output", default=".understudy/validate-and-optimize/gepa-run.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    gate = validate_gate(repo, artifact_root=args.artifact_root)
    gepa_available = importlib.util.find_spec("gepa") is not None
    blockers = list(gate["blockers"])
    if not args.dry_run and not gepa_available:
        blockers.append(
            {
                "name": "gepa",
                "reason": "gepa is not installed; install explicitly before optimizer execution",
                "install_hints": INSTALL_HINTS,
            }
        )
    payload = {
        "schema_version": "understudy.gepa_run_gate.v1",
        "status": "blocked" if blockers else ("dry-run" if args.dry_run else "ready"),
        "mode": "dry-run" if args.dry_run else "run",
        "gepa_available": gepa_available,
        "budget_usd": args.budget_usd,
        "install_hints": INSTALL_HINTS if not gepa_available else [],
        "artifact_gate": gate,
        "blockers": blockers,
        "executed": False,
        "notes": [
            "GEPA execution is train/dev only.",
            "Holdout remains sealed until a candidate is frozen.",
            "This script never installs packages automatically.",
        ],
    }
    output = Path(args.output).expanduser()
    if not output.is_absolute():
        output = repo / output
    write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"status: {payload['status']}")
        for hint in payload["install_hints"]:
            print(f"install: {hint}")
        for blocker in blockers:
            print(f"- {blocker['name']}: {blocker['reason']}")
    return 0 if payload["status"] in {"ready", "dry-run"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
