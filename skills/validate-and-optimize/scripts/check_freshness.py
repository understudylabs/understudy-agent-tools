#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import validate_gate, write_json


def main() -> int:
    parser = argparse.ArgumentParser(description="Check validate-and-optimize artifact freshness gates.")
    parser.add_argument("--repo", default=".", help="Local repository root.")
    parser.add_argument("--artifact-root", default=None, help="Artifact root relative to repo; defaults to .understudy/understand-workload.")
    parser.add_argument("--output", default=".understudy/validate-and-optimize/gate.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    payload = validate_gate(repo, artifact_root=args.artifact_root)
    output = (repo / args.output).resolve() if not Path(args.output).is_absolute() else Path(args.output)
    write_json(output, payload)
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"wrote {output}")
        print(f"status: {payload['status']}")
        for blocker in payload["blockers"]:
            print(f"- {blocker['name']}: {blocker.get('path', '<unknown>')} ({blocker['reason']})")
    return 0 if payload["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
