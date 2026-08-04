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
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any, Optional

# Values tinker.types.StopReason may take.
_SAMPLER_STOP = "stop"
_SAMPLER_LENGTH = "length"
# tinker_cookbook renderers.base.ParseTermination values that mean a clean end.
_CLEAN_TERMINATIONS = ("stop_sequence", "eos")


def parse_openai_request_body(raw: bytes, *, max_bytes: int) -> dict[str, Any]:
    """Parse a bounded OpenAI request body without retaining or echoing values."""
    if not isinstance(raw, bytes) or not raw or len(raw) > max_bytes:
        raise ValueError("request body size is invalid")
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("request body must contain valid JSON") from error
    if not isinstance(parsed, dict):
        raise ValueError("request body must be a JSON object")
    return parsed


def validated_generation_args(body: dict[str, Any], *, configured_max_tokens: int) -> tuple[float, int]:
    """Validate caller-controlled sampling values against the serving cap."""
    if not isinstance(body.get("messages"), list):
        raise ValueError("messages must be a list")
    if "tools" in body and not isinstance(body.get("tools"), list):
        raise ValueError("tools must be a list")
    max_tokens = body.get("max_tokens", configured_max_tokens)
    if (
        not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or max_tokens <= 0
        or max_tokens > configured_max_tokens
    ):
        raise ValueError("max_tokens must be a positive integer within the serving cap")
    temperature = body.get("temperature", 0.0)
    if not isinstance(temperature, (int, float)) or isinstance(temperature, bool):
        raise ValueError("temperature must be numeric")
    temperature = float(temperature)
    if not 0.0 <= temperature <= 2.0:
        raise ValueError("temperature must be between 0 and 2")
    return temperature, max_tokens


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
    if isinstance(error, ValueError) or type_name == "BadRequestError" or "exceeds the model's context window" in lowered:
        code = "context_length_exceeded" if "context window" in lowered else "invalid_request"
        return 400, {
            "error": {
                "message": detail[:500],
                "type": "invalid_request_error",
                "code": code,
            }
        }
    if isinstance(error, TimeoutError):
        return 504, {
            "error": {
                "message": detail[:500],
                "type": "server_error",
                "code": "upstream_timeout",
            }
        }
    return 500, {
        "error": {
            "message": f"{type_name}: {detail}"[:500],
            "type": "server_error",
            "code": "upstream_error",
        }
    }


def _typed_object(value: Any, *, label: str) -> dict[str, Any]:
    """Project SDK model/dataclass objects onto a JSON-compatible mapping.

    Tinker and renderer releases have returned both dictionaries and typed
    ``ToolCall`` objects.  Normalize those dependency shapes explicitly rather
    than assuming ``.get`` exists or serializing arbitrary private attributes.
    """
    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        projected = model_dump(mode="json")
    elif is_dataclass(value) and not isinstance(value, type):
        projected = asdict(value)
    else:
        projected = {
            field: getattr(value, field)
            for field in ("role", "content", "tool_calls", "id", "type", "function", "name", "arguments")
            if hasattr(value, field)
        }
    if not isinstance(projected, dict):
        raise ValueError(f"{label} must normalize to an object")
    return projected


def normalize_assistant_message(message: Any, request_id: str) -> dict[str, Any]:
    """Return strict OpenAI assistant shape with stable tool-call IDs/arguments."""
    message = _typed_object(message, label="assistant message")
    normalized = {"role": "assistant", "content": message.get("content") or ""}
    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, (list, tuple)):
        raise ValueError("assistant tool_calls must be a list or tuple")
    if raw_calls:
        calls = []
        for index, raw in enumerate(raw_calls):
            raw = _typed_object(raw, label=f"tool call {index}")
            function = _typed_object(raw.get("function") or {}, label=f"tool call {index} function")
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
) -> dict:
    """Build the /v1/chat/completions response body.

    finish_reason is a required positional argument: constructing the choice
    object without a defined finish_reason is impossible here, which is exactly
    the undefined-variable (NameError) failure this module exists to prevent.
    """
    response_finish_reason = (
        "tool_calls"
        if message.get("tool_calls") and finish_reason != "length"
        else finish_reason
    )
    return {
        "choices": [
            {
                "message": message,
                "finish_reason": response_finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        },
    }
