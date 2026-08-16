#!/usr/bin/env python3
"""Side-effect-free OpenAI-compat helpers for the Tinker sampling shim.

Importing this module must NOT touch argparse, the network, or a Tinker
ServiceClient, so provider-free unit tests can import it directly. The shim
(``scripts/tinker-openai-shim.py``) imports these two helpers and does the live
sampling itself.

Finish-reason contract (see tinker.types.StopReason == Literal['length','stop']
and tinker_cookbook ParseTermination == {'stop_sequence','eos','malformed'}):

  * Prefer the upstream sampler stop_reason when present ('length'->'length',
    'stop'->'stop').
  * Else use the renderer termination: a clean stop ('stop_sequence'/'eos')
    -> 'stop'; a 'malformed' (truncated) termination is treated as reason-absent
    for the stop/length distinction and falls through to cap inference.
  * Only when no upstream reason is present do we infer 'length' from
    completion_tokens >= max_tokens; otherwise fall back to 'stop'.

We never invent OpenAI reasons the upstream cannot justify (e.g. no
'content_filter' unless the upstream actually reports one).
"""
from __future__ import annotations

import hmac
import json
import time
import uuid
from typing import Any, Optional

# Values tinker.types.StopReason may take.
_SAMPLER_STOP = "stop"
_SAMPLER_LENGTH = "length"
# tinker_cookbook renderers.base.ParseTermination values that mean a clean end.
_CLEAN_TERMINATIONS = ("stop_sequence", "eos")


class InvalidRequestError(ValueError):
    """A bounded client request error that must be returned as HTTP 400."""


def parse_chat_request(raw: bytes) -> dict[str, Any]:
    """Decode and minimally validate an OpenAI chat-completions request."""
    try:
        body = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidRequestError("request body must be valid UTF-8 JSON") from error
    if not isinstance(body, dict):
        raise InvalidRequestError("request body must be a JSON object")
    if not isinstance(body.get("messages"), list):
        raise InvalidRequestError("messages must be a JSON array")
    return body


def openai_error_response(error: Exception) -> tuple[int, dict[str, Any]]:
    """Map sampler failures without disguising deterministic client errors.

    Tinker raises ``BadRequestError`` for prompt-plus-generation context-window
    overflow. Returning 500 for that condition made the Gateway and evaluator
    treat deterministic, model-incompatible requests as retryable provider
    pressure. Keep the response bounded and OpenAI-shaped while preserving the
    actionable error class.
    """
    detail = str(error)
    lowered = detail.lower()
    type_name = type(error).__name__
    if isinstance(error, InvalidRequestError):
        return 400, {
            "error": {
                "message": detail[:500],
                "type": "invalid_request_error",
                "code": "invalid_request",
            }
        }
    if type_name == "BadRequestError" or "exceeds the model's context window" in lowered:
        code = "context_length_exceeded" if "context window" in lowered else "invalid_request"
        return 400, {
            "error": {
                "message": (
                    "request exceeds the model context window"
                    if code == "context_length_exceeded"
                    else "upstream rejected the request"
                ),
                "type": "invalid_request_error",
                "code": code,
            }
        }
    if isinstance(error, TimeoutError):
        return 504, {
            "error": {
                "message": "upstream sampling timed out",
                "type": "server_error",
                "code": "upstream_timeout",
            }
        }
    return 500, {
        "error": {
            "message": "upstream sampling failed",
            "type": "server_error",
            "code": "upstream_error",
        }
    }


def normalize_assistant_message(message: dict[str, Any], request_id: str) -> dict[str, Any]:
    """Return strict OpenAI assistant shape with stable tool-call IDs/arguments."""
    normalized = {"role": "assistant", "content": message.get("content") or ""}
    raw_calls = message.get("tool_calls") or []
    if raw_calls:
        calls = []
        for index, raw in enumerate(raw_calls):
            function = raw.get("function") or {}
            arguments = function.get("arguments", "{}")
            if isinstance(arguments, dict):
                arguments = json.dumps(arguments, sort_keys=True)
            if not isinstance(arguments, str):
                raise ValueError("parsed tool arguments must be a JSON string or object")
            json.loads(arguments)
            call_id = raw.get("id") or (
                "call_"
                + uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"understudy:tinker:{request_id}:{index}:{function.get('name')}",
                ).hex
            )
            calls.append(
                {
                    "type": "function",
                    "id": call_id,
                    "function": {"name": function["name"], "arguments": arguments},
                }
            )
        normalized["tool_calls"] = calls
    return normalized


def bearer_authorized(header: Optional[str], expected_token: Optional[str]) -> bool:
    """Constant-time Bearer-token verification.

    A configured service token is mandatory for non-loopback deployments.  The
    caller decides whether an unset token is acceptable for its bind address.
    """
    if not expected_token or not header or not header.startswith("Bearer "):
        return False
    supplied = header.removeprefix("Bearer ").strip()
    return bool(supplied) and hmac.compare_digest(supplied, expected_token)


def normalize_finish_reason(
    stop_reason: Optional[str] = None,
    termination: Optional[str] = None,
    completion_tokens: Optional[int] = None,
    max_tokens: Optional[int] = None,
) -> str:
    """Return an OpenAI-compatible finish_reason ('stop' or 'length').

    ``stop_reason``  : upstream sampler StopReason ('stop'/'length') or None.
    ``termination``  : renderer ParseTermination value or None.
    ``completion_tokens`` / ``max_tokens`` : used only for cap inference when no
    upstream reason is available.
    """
    # Coerce both signals to plain strings so an enum/StrEnum (or anything with a
    # str form) compares correctly; None stays None.
    stop = None if stop_reason is None else str(stop_reason)
    term = None if termination is None else str(termination)
    if stop == _SAMPLER_LENGTH:
        return "length"
    if stop == _SAMPLER_STOP:
        return "stop"
    # No authoritative sampler reason: consult a clean renderer termination.
    if term in _CLEAN_TERMINATIONS:
        return "stop"
    # Reason absent (or 'malformed'/truncated): infer length only at the cap.
    if (
        completion_tokens is not None
        and max_tokens is not None
        and completion_tokens >= max_tokens
    ):
        return "length"
    return "stop"


def build_chat_completion(
    message: dict[str, Any],
    prompt_tokens: int,
    completion_tokens: int,
    finish_reason: str,
    *,
    model: str = "unknown",
    request_id: Optional[str] = None,
    created: Optional[int] = None,
) -> dict:
    """Build the /v1/chat/completions response body.

    finish_reason is a required positional argument: constructing the choice
    object without a defined finish_reason is impossible here, which is exactly
    the undefined-variable (NameError) failure this module exists to prevent.
    """
    completion_id = request_id or str(uuid.uuid4())
    return {
        "id": f"chatcmpl-{completion_id}",
        "object": "chat.completion",
        "created": int(time.time()) if created is None else created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }
