#!/usr/bin/env python3
"""Provider-free parity scorer for Tinker and vLLM rollout captures."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from nemotron_long_context_contract import PARITY_SCHEMA, messages_sha256


def _canonical_tool_calls(message: dict) -> list[dict]:
    calls = message.get("tool_calls", [])
    if not isinstance(calls, list):
        raise ValueError("assistant tool_calls must be an array")
    normalized = []
    for call in calls:
        function = call.get("function", {})
        arguments = function.get("arguments", "{}")
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        normalized.append({"name": function.get("name"), "arguments": arguments})
    return normalized


def _load(path: Path) -> dict[str, dict]:
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or case_id in rows:
            raise ValueError("every parity row needs a unique case_id")
        row["messages_sha256"] = messages_sha256(row.get("messages"))
        rows[case_id] = row
    if not rows:
        raise ValueError("parity input is empty")
    return rows


def score(tinker_path: Path, vllm_path: Path, artifact_sha256: str) -> dict:
    if len(artifact_sha256) != 64 or any(c not in "0123456789abcdef" for c in artifact_sha256):
        raise ValueError("artifact sha256 must be lowercase hex")
    tinker = _load(tinker_path)
    vllm = _load(vllm_path)
    if tinker.keys() != vllm.keys():
        raise ValueError("parity lanes must contain exactly the same case ids")
    rows = []
    for case_id in sorted(tinker):
        left, right = tinker[case_id], vllm[case_id]
        if left["messages_sha256"] != right["messages_sha256"]:
            raise ValueError(f"input messages changed for {case_id}")
        if left.get("input_tokens", 0) > 131_072 or right.get("input_tokens", 0) > 131_072:
            raise ValueError(f"case exceeds the certified context window: {case_id}")
        if left.get("truncated") or right.get("truncated"):
            raise ValueError(f"truncated parity row is inadmissible: {case_id}")
        left_message = left.get("assistant_message", {})
        right_message = right.get("assistant_message", {})
        equivalent = (
            _canonical_tool_calls(left_message) == _canonical_tool_calls(right_message)
            and left.get("finish_reason") == right.get("finish_reason")
        )
        rows.append({
            "case_id": case_id,
            "messages_sha256": left["messages_sha256"],
            "equivalent": equivalent,
            "tinker_input_tokens": left.get("input_tokens"),
            "vllm_input_tokens": right.get("input_tokens"),
        })
    passed = all(row["equivalent"] for row in rows)
    return {
        "schema_version": PARITY_SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "artifact_sha256": artifact_sha256,
        "cases": len(rows),
        "equivalent_cases": sum(row["equivalent"] for row in rows),
        "messages_preserved": True,
        "truncation_observed": False,
        "passed": passed,
        "rows": rows,
        "claim_boundary": "provider-free capture comparison; no quality or holdout claim",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tinker", type=Path, required=True)
    parser.add_argument("--vllm", type=Path, required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    receipt = score(args.tinker, args.vllm, args.artifact_sha256)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
