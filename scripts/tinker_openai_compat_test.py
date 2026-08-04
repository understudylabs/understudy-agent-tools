#!/usr/bin/env python3
"""Provider-free regression for the Tinker shim's OpenAI-compat helpers.

Runs with plain system python3 (no tinker, no network):
    python3 scripts/tinker_openai_compat_test.py

Proves the finish-reason contract and that building the response body cannot
recur the original undefined-`finish_reason` NameError.
"""
from enum import Enum

from tinker_openai_compat import (
    bearer_authorized,
    build_chat_completion,
    normalize_finish_reason,
)


class _ParseTermination(str, Enum):
    """Shape-compatible stand-in for tinker_cookbook ParseTermination."""
    STOP_SEQUENCE = "stop_sequence"
    EOS = "eos"
    MALFORMED = "malformed"


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"  ok: {name}")


def test_upstream_stop():
    check("upstream stop -> stop",
          normalize_finish_reason(stop_reason="stop", completion_tokens=384, max_tokens=384) == "stop")


def test_upstream_length():
    # upstream length wins even below the cap
    check("upstream length -> length",
          normalize_finish_reason(stop_reason="length", completion_tokens=10, max_tokens=384) == "length")


def test_absent_at_cap_infers_length():
    check("absent + at cap -> length",
          normalize_finish_reason(stop_reason=None, termination=None, completion_tokens=384, max_tokens=384) == "length")


def test_absent_under_cap_falls_back_stop():
    check("absent + under cap -> stop",
          normalize_finish_reason(stop_reason=None, termination=None, completion_tokens=12, max_tokens=384) == "stop")


def test_enum_shaped_terminations_map_to_stop():
    # exactly how the shim passes it: getattr(term, "value", term)
    for term in (_ParseTermination.EOS, _ParseTermination.STOP_SEQUENCE):
        passed = getattr(term, "value", term)
        check(f"enum termination {term.value!r} -> stop",
              normalize_finish_reason(termination=passed, completion_tokens=5, max_tokens=384) == "stop")


def test_unknown_non_clean_termination_falls_through_to_cap():
    # 'malformed' (or any non-clean) is NOT treated as a stop/length signal;
    # it falls through to cap inference.
    passed = getattr(_ParseTermination.MALFORMED, "value", _ParseTermination.MALFORMED)
    check("malformed + at cap -> length (cap inference)",
          normalize_finish_reason(termination=passed, completion_tokens=384, max_tokens=384) == "length")
    check("malformed + under cap -> stop (fallback)",
          normalize_finish_reason(termination=passed, completion_tokens=7, max_tokens=384) == "stop")


def test_payload_requires_defined_finish_reason():
    # The exact code path that once raised NameError: build the choice object
    # with a normalized finish_reason. It is a required positional arg, so an
    # undefined variable cannot silently slip through.
    fr = normalize_finish_reason(stop_reason="stop", completion_tokens=3, max_tokens=384)
    payload = build_chat_completion("hello", 100, 3, fr)
    check("payload choices[0].finish_reason present", payload["choices"][0]["finish_reason"] == "stop")
    check("payload content propagated", payload["choices"][0]["message"]["content"] == "hello")
    check("payload usage propagated",
          payload["usage"] == {"prompt_tokens": 100, "completion_tokens": 3})

    fr_len = normalize_finish_reason(stop_reason="length", completion_tokens=384, max_tokens=384)
    payload_len = build_chat_completion("", 100, 384, fr_len)
    check("length propagates into payload", payload_len["choices"][0]["finish_reason"] == "length")


def test_bearer_auth_is_fail_closed():
    check("missing expected token rejects", bearer_authorized("Bearer x", None) is False)
    check("missing header rejects", bearer_authorized(None, "secret") is False)
    check("wrong scheme rejects", bearer_authorized("Basic secret", "secret") is False)
    check("wrong token rejects", bearer_authorized("Bearer wrong", "secret") is False)
    check("matching token authorizes", bearer_authorized("Bearer secret", "secret") is True)


def main():
    tests = [
        test_upstream_stop,
        test_upstream_length,
        test_absent_at_cap_infers_length,
        test_absent_under_cap_falls_back_stop,
        test_enum_shaped_terminations_map_to_stop,
        test_unknown_non_clean_termination_falls_through_to_cap,
        test_payload_requires_defined_finish_reason,
        test_bearer_auth_is_fail_closed,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} SHIM COMPAT TESTS PASSED")


if __name__ == "__main__":
    main()
