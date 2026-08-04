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
from typing import Optional

# Values tinker.types.StopReason may take.
_SAMPLER_STOP = "stop"
_SAMPLER_LENGTH = "length"
# tinker_cookbook renderers.base.ParseTermination values that mean a clean end.
_CLEAN_TERMINATIONS = ("stop_sequence", "eos")


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
    message: dict,
    prompt_tokens: int,
    completion_tokens: int,
    finish_reason: str,
) -> dict:
    """Build the /v1/chat/completions response body without dropping tool calls.

    finish_reason is a required positional argument: constructing the choice
    object without a defined finish_reason is impossible here, which is exactly
    the undefined-variable (NameError) failure this module exists to prevent.
    """
    choice_message = {
        "role": "assistant",
        "content": message.get("content", ""),
    }
    if message.get("tool_calls"):
        choice_message["tool_calls"] = message["tool_calls"]
    return {
        "choices": [
            {
                "message": choice_message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        },
    }


def renderer_messages(renderer, messages: list[dict], tools: list[dict]) -> list[dict]:
    """Convert OpenAI chat messages into the renderer's lossless conversation."""
    system_messages = [message for message in messages if message.get("role") == "system"]
    conversation = [message for message in messages if message.get("role") != "system"]
    system_content = "\n\n".join(
        str(message.get("content") or "") for message in system_messages
    )
    tool_specs = [
        tool["function"]
        for tool in tools
        if isinstance(tool, dict)
        and tool.get("type") == "function"
        and isinstance(tool.get("function"), dict)
    ]
    if tool_specs:
        prefix = renderer.create_conversation_prefix_with_tools(
            tool_specs,
            system_prompt=system_content,
        )
    elif system_messages:
        prefix = [{"role": "system", "content": system_content}]
    else:
        prefix = []
    return [*prefix, *conversation]
