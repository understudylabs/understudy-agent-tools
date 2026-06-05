#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from _common import read_json_object, write_json
from understudy_agent_tools.artifact_contract import validate_metric_contract


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the human-confirmed metric contract.")
    parser.add_argument("--metric", default=".understudy/understand-workload/metric.json")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--output", default=".understudy/validate-and-optimize/metric-gate.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    metric_path = Path(args.metric).expanduser()
    if not metric_path.is_absolute():
        metric_path = repo / metric_path
    blockers: list[dict[str, object]]
    try:
        metric = read_json_object(metric_path)
        blockers = validate_metric_contract(metric)
    except FileNotFoundError:
        metric = {}
        blockers = [{"name": "metric", "path": str(metric_path), "reason": "missing metric.json"}]
    except json.JSONDecodeError as exc:
        metric = {}
        blockers = [{"name": "metric", "path": str(metric_path), "reason": f"invalid JSON: {exc.msg}"}]
    except ValueError as exc:
        metric = {}
        blockers = [{"name": "metric", "path": str(metric_path), "reason": str(exc)}]

    payload = {
        "schema_version": "understudy.metric_gate.v1",
        "status": "blocked" if blockers else "ok",
        "metric_schema_version": metric.get("schema_version"),
        "blockers": blockers,
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
        for blocker in blockers:
            print(f"- {blocker['reason']}")
    return 0 if not blockers else 2


if __name__ == "__main__":
    raise SystemExit(main())
