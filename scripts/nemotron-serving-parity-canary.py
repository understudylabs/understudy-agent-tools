#!/usr/bin/env python3
"""Fail-closed HTTP canary for a frozen Nemotron serving-parity bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(opener, request, timeout):
    started = time.monotonic()
    try:
        response = opener.open(request, timeout=timeout)
        body = response.read()
        return response.status, body, time.monotonic() - started
    except urllib.error.HTTPError as error:
        try:
            body = error.read()
        except (AttributeError, KeyError):
            body = b""
        return error.code, body, time.monotonic() - started
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return None, str(error).encode(), time.monotonic() - started


def _tool_calls(message):
    normalized = []
    for call in message.get("tool_calls", []):
        function = call.get("function", {})
        arguments = function.get("arguments", "{}")
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        normalized.append({"name": function.get("name"), "arguments": arguments})
    return normalized


def _sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def run(rows, endpoint, health_endpoint, headers, artifact_sha256, timeout=180, readiness_attempts=3, opener=None):
    if len(artifact_sha256) != 64 or any(character not in "0123456789abcdef" for character in artifact_sha256):
        raise ValueError("artifact sha256 must be lowercase hex")
    case_ids = [row.get("case_id") for row in rows]
    if not case_ids or any(not isinstance(case_id, str) for case_id in case_ids) or len(set(case_ids)) != len(case_ids):
        raise ValueError("canary needs non-empty rows with unique case ids")
    bundle_sha256 = _sha256(rows)
    opener = opener or urllib.request.build_opener(NoRedirect())
    if readiness_attempts < 1:
        raise ValueError("readiness attempts must be positive")
    readiness = []
    health_status = None
    for attempt in range(1, readiness_attempts + 1):
        health = urllib.request.Request(health_endpoint, headers=headers, method="GET")
        health_status, _, health_latency = _request(opener, health, timeout)
        readiness.append({"attempt": attempt, "status": health_status, "latency_seconds": health_latency})
        if health_status == 200:
            break
    receipt_rows = []
    if health_status != 200:
        return {
            "ready": False,
            "health_status": health_status,
            "readiness": readiness,
            "inference_posts": 0,
            "artifact_sha256": artifact_sha256,
            "bundle_sha256": bundle_sha256,
            "passed": False,
            "rows": receipt_rows,
        }

    outcomes = {}
    posts = 0
    for row in rows:
        case_id = row["case_id"]
        parent = row.get("continuation_of")
        if parent and outcomes.get(parent) != "action_match":
            outcome = "suppressed_parent_transport_failure"
            receipt_rows.append({"case_id": case_id, "outcome": outcome, "action_parity": None})
            outcomes[case_id] = outcome
            continue
        payload = {
            "model": row["model"],
            "messages": row["messages"],
            "tools": row["tools"],
            **row["sampling"],
        }
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, separators=(",", ":")).encode(),
            headers={**headers, "Content-Type": "application/json"},
            method="POST",
        )
        status, body, latency = _request(opener, request, timeout)
        posts += 1
        if status != 200:
            outcome = "transport_failure"
            action_parity = None
            finish_reason = None
            completion_tokens = None
        else:
            try:
                response = json.loads(body)
                choice = response["choices"][0]
                actual = _tool_calls(choice["message"])
                expected = _tool_calls(row["expected_assistant_message"])
                finish_reason = choice.get("finish_reason")
                completion_tokens = response.get("usage", {}).get("completion_tokens")
                action_parity = actual == expected and finish_reason != "length"
                outcome = "action_match" if action_parity else "action_mismatch"
            except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
                outcome = "malformed_response"
                action_parity = False
                finish_reason = None
                completion_tokens = None
        outcomes[case_id] = outcome
        receipt_rows.append({
            "case_id": case_id,
            "http_status": status,
            "latency_seconds": latency,
            "outcome": outcome,
            "action_parity": action_parity,
            "finish_reason": finish_reason,
            "completion_tokens": completion_tokens,
        })
    return {
        "ready": True,
        "health_status": health_status,
        "readiness": readiness,
        "inference_posts": posts,
        "artifact_sha256": artifact_sha256,
        "bundle_sha256": bundle_sha256,
        "passed": bool(receipt_rows) and all(row["outcome"] == "action_match" for row in receipt_rows),
        "rows": receipt_rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--health-endpoint", required=True)
    parser.add_argument("--proxy-key", required=True)
    parser.add_argument("--proxy-secret", required=True)
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    parser.add_argument("--readiness-attempts", type=int, default=3)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
    receipt = run(
        rows,
        args.endpoint,
        args.health_endpoint,
        {"Modal-Key": args.proxy_key, "Modal-Secret": args.proxy_secret},
        args.artifact_sha256,
        args.timeout_seconds,
        args.readiness_attempts,
    )
    receipt.update({
        "schema_version": "understudy.nemotron_serving_parity_canary.v1",
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "claim_boundary": "TRAIN serving parity only; no DEV, quality, or holdout claim",
    })
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0 if receipt["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
