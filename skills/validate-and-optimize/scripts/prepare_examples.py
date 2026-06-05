#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from _common import write_json


TARGET_FIELDS = {"expected", "expected_label", "answer", "label", "target", "gold"}


def load_rows(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".jsonl":
        rows = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            payload = json.loads(line)
            if not isinstance(payload, dict):
                payload = {"value": payload}
            payload.setdefault("_source_ref", f"{path.name}:{line_number}")
            rows.append(payload)
        return rows
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            return [row if isinstance(row, dict) else {"value": row} for row in payload]
        if isinstance(payload, dict):
            records = payload.get("records") or payload.get("rows") or payload.get("examples")
            if isinstance(records, list):
                return [row if isinstance(row, dict) else {"value": row} for row in records]
            return [payload]
        return [{"value": payload}]
    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    raise ValueError(f"unsupported source type: {suffix or '<none>'}")


def to_example(row: dict[str, Any], index: int, source_path: Path) -> dict[str, Any]:
    target = {key: row[key] for key in TARGET_FIELDS if key in row}
    inputs = {key: value for key, value in row.items() if key not in TARGET_FIELDS and not key.startswith("_")}
    return {
        "id": str(row.get("id") or row.get("row_id") or f"row-{index:03d}"),
        "inputs": inputs,
        "target": target,
        "metadata": {
            "source_ref": str(row.get("_source_ref") or f"{source_path.name}:{index}"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare local rows as validate-and-optimize examples.")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--source", required=True, help="JSONL, JSON, or CSV source.")
    parser.add_argument("--output", default=".understudy/validate-and-optimize/examples.json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    source = Path(args.source).expanduser()
    if not source.is_absolute():
        source = repo / source
    rows = load_rows(source)
    examples = [to_example(row, index, source) for index, row in enumerate(rows, start=1)]
    payload = {
        "schema_version": "understudy.eval_examples.v1",
        "source": str(source),
        "example_count": len(examples),
        "examples": examples,
        "notes": [
            "Rows stay local.",
            "Freeze splits before optimization.",
            "GEPA may consume train/dev examples only.",
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
        print(f"examples: {len(examples)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
