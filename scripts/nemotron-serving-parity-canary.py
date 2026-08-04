#!/usr/bin/env python3
"""Fail-closed HTTP canary for a frozen Nemotron serving-parity bundle."""

from __future__ import annotations

import argparse
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


def run(rows, endpoint, health_endpoint, headers, timeout=180, opener=None):
    opener = opener or urllib.request.build_opener(NoRedirect())
    health = urllib.request.Request(health_endpoint, headers=headers, method="GET")
    health_status, _, health_latency = _request(opener, health, timeout)
    receipt_rows = []
    if health_status != 200:
        return {
            "ready": False,
            "health_status": health_status,
            "health_latency_seconds": health_latency,
            "inference_posts": 0,
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
        "health_latency_seconds": health_latency,
        "inference_posts": posts,
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
    parser.add_argument("--timeout-seconds", type=float, default=180)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
    receipt = run(
        rows,
        args.endpoint,
        args.health_endpoint,
        {"Modal-Key": args.proxy_key, "Modal-Secret": args.proxy_secret},
        args.timeout_seconds,
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
