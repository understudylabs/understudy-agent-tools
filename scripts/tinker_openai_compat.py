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

from typing import Optional

# Values tinker.types.StopReason may take.
_SAMPLER_STOP = "stop"
_SAMPLER_LENGTH = "length"
# tinker_cookbook renderers.base.ParseTermination values that mean a clean end.
_CLEAN_TERMINATIONS = ("stop_sequence", "eos")


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
    content: str,
    prompt_tokens: int,
    completion_tokens: int,
    finish_reason: str,
) -> dict:
    """Build the /v1/chat/completions response body.

    finish_reason is a required positional argument: constructing the choice
    object without a defined finish_reason is impossible here, which is exactly
    the undefined-variable (NameError) failure this module exists to prevent.
    """
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
        },
    }
