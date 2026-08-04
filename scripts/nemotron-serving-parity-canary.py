#!/usr/bin/env python3
"""Fail-closed HTTP canary for a frozen Nemotron serving-parity bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from nemotron_long_context_contract import require_proxy_auth_environment


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


def _validate_wire_tool_calls(message, *, label):
    """Reject dependency-coerced tool calls before any provider request.

    OpenAI-compatible tool arguments are JSON *strings* on the wire.  Keeping
    that distinction explicit prevents framework-specific schema coercion from
    silently changing a frozen continuation fixture before it is compared.
    """
    tool_calls = message.get("tool_calls", [])
    if not isinstance(tool_calls, list):
        raise ValueError(f"{label} tool_calls must be a list")
    for index, call in enumerate(tool_calls):
        if not isinstance(call, dict):
            raise ValueError(f"{label} tool call {index} must be a dict")
        function = call.get("function")
        if not isinstance(function, dict):
            raise ValueError(f"{label} tool call {index} function must be a dict")
        if not isinstance(function.get("name"), str):
            raise ValueError(f"{label} tool call {index} function name must be a string")
        arguments = function.get("arguments")
        if not isinstance(arguments, str):
            raise ValueError(f"{label} tool call {index} arguments must remain a JSON string")
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError as error:
            raise ValueError(f"{label} tool call {index} arguments must contain valid JSON") from error
        if not isinstance(decoded, dict):
            raise ValueError(f"{label} tool call {index} arguments JSON must decode to an object")


def _sha256(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def _body_sha256(body):
    return hashlib.sha256(body).hexdigest()


def _response_shape(response):
    """Retain response structure without retaining model-generated values."""
    shape = {"top_level_type": type(response).__name__}
    if not isinstance(response, dict):
        return shape
    shape["top_level_keys"] = sorted(response)
    choices = response.get("choices")
    shape["choices_type"] = type(choices).__name__
    shape["choices_count"] = len(choices) if isinstance(choices, list) else None
    if isinstance(choices, list) and choices:
        choice = choices[0]
        shape["choice_0_type"] = type(choice).__name__
        if isinstance(choice, dict):
            shape["choice_0_keys"] = sorted(choice)
            shape["finish_reason_type"] = type(choice.get("finish_reason")).__name__
            shape["finish_reason"] = choice.get("finish_reason") if choice.get("finish_reason") in {
                None, "stop", "length", "tool_calls", "content_filter",
            } else "other"
            message = choice.get("message")
            shape["message_type"] = type(message).__name__
            if isinstance(message, dict):
                shape["message_keys"] = sorted(message)
                shape["content_type"] = type(message.get("content")).__name__
                tool_calls = message.get("tool_calls")
                shape["tool_calls_type"] = type(tool_calls).__name__
                shape["tool_calls_count"] = len(tool_calls) if isinstance(tool_calls, list) else None
                if isinstance(tool_calls, list) and tool_calls:
                    call = tool_calls[0]
                    shape["tool_call_0_type"] = type(call).__name__
                    if isinstance(call, dict):
                        shape["tool_call_0_keys"] = sorted(call)
                        function = call.get("function")
                        shape["tool_call_0_function_type"] = type(function).__name__
                        if isinstance(function, dict):
                            shape["tool_call_0_function_keys"] = sorted(function)
    usage = response.get("usage")
    shape["usage_type"] = type(usage).__name__
    if isinstance(usage, dict):
        shape["usage_keys"] = sorted(usage)
        shape["usage_value_types"] = {key: type(value).__name__ for key, value in sorted(usage.items())}
    return shape


def run(rows, endpoint, health_endpoint, headers, artifact_sha256, timeout=180, readiness_attempts=3, opener=None):
    if len(artifact_sha256) != 64 or any(character not in "0123456789abcdef" for character in artifact_sha256):
        raise ValueError("artifact sha256 must be lowercase hex")
    case_ids = [row.get("case_id") for row in rows]
    if not case_ids or any(not isinstance(case_id, str) for case_id in case_ids) or len(set(case_ids)) != len(case_ids):
        raise ValueError("canary needs non-empty rows with unique case ids")
    required_types = {
        "model": str,
        "messages": list,
        "tools": list,
        "sampling": dict,
        "expected_assistant_message": dict,
    }
    for row in rows:
        for field, expected_type in required_types.items():
            if not isinstance(row.get(field), expected_type):
                raise ValueError(f"case {row['case_id']} needs {field} as {expected_type.__name__}")
        expected_hash = row.get("expected_assistant_message_sha256")
        if expected_hash is not None and expected_hash != _sha256(row["expected_assistant_message"]):
            raise ValueError(f"case {row['case_id']} expected assistant message hash mismatch")
        _validate_wire_tool_calls(
            row["expected_assistant_message"],
            label=f"case {row['case_id']} expected assistant message",
        )
        for index, message in enumerate(row["messages"]):
            if not isinstance(message, dict):
                raise ValueError(f"case {row['case_id']} message {index} must be a dict")
            if "tool_calls" in message:
                _validate_wire_tool_calls(
                    message,
                    label=f"case {row['case_id']} message {index}",
                )
        context_fields = ("source_prompt_tokens", "source_context_limit")
        supplied_context_fields = [field for field in context_fields if field in row]
        if supplied_context_fields and len(supplied_context_fields) != len(context_fields):
            raise ValueError(
                f"case {row['case_id']} must provide source_prompt_tokens and source_context_limit together"
            )
        if supplied_context_fields:
            prompt_tokens = row["source_prompt_tokens"]
            context_limit = row["source_context_limit"]
            max_tokens = row["sampling"].get("max_tokens")
            margin = row.get("source_context_safety_margin", 0)
            if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in (
                prompt_tokens, context_limit, max_tokens, margin,
            )):
                raise ValueError(f"case {row['case_id']} source context budget fields must be nonnegative integers")
            if prompt_tokens + max_tokens + margin > context_limit:
                raise ValueError(
                    f"case {row['case_id']} exceeds source sampler context budget before network"
                )
        parent = row.get("continuation_of")
        if parent is not None and parent not in case_ids:
            raise ValueError(f"case {row['case_id']} references unknown continuation parent")
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
        body_sha256 = _body_sha256(body)
        body_bytes = len(body)
        response_shape = None
        parse_error_type = None
        parse_error_stage = None
        if status != 200:
            outcome = "transport_failure"
            action_parity = None
            finish_reason = None
            completion_tokens = None
        else:
            try:
                response = json.loads(body)
                response_shape = _response_shape(response)
                choice = response["choices"][0]
                parse_error_stage = "actual_tool_calls"
                actual = _tool_calls(choice["message"])
                parse_error_stage = "expected_tool_calls"
                expected = _tool_calls(row["expected_assistant_message"])
                parse_error_stage = "comparison"
                finish_reason = choice.get("finish_reason")
                completion_tokens = response.get("usage", {}).get("completion_tokens")
                action_parity = actual == expected and finish_reason != "length"
                outcome = "action_match" if action_parity else "action_mismatch"
            except (AttributeError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
                outcome = "malformed_response"
                action_parity = False
                finish_reason = None
                completion_tokens = None
                parse_error_type = type(error).__name__
        outcomes[case_id] = outcome
        receipt_rows.append({
            "case_id": case_id,
            "http_status": status,
            "latency_seconds": latency,
            "outcome": outcome,
            "action_parity": action_parity,
            "finish_reason": finish_reason,
            "completion_tokens": completion_tokens,
            "body_bytes": body_bytes,
            "body_sha256": body_sha256,
            "response_shape": response_shape,
            "parse_error_type": parse_error_type,
            "parse_error_stage": parse_error_stage if parse_error_type else None,
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
    parser.add_argument("--artifact-sha256", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=180)
    parser.add_argument("--readiness-attempts", type=int, default=3)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    proxy_key, proxy_secret = require_proxy_auth_environment(os.environ)
    rows = [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
    receipt = run(
        rows,
        args.endpoint,
        args.health_endpoint,
        {"Modal-Key": proxy_key, "Modal-Secret": proxy_secret},
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
