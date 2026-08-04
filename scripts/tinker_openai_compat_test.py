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
    normalize_assistant_message,
    normalize_finish_reason,
    openai_error_response,
    parse_openai_request_body,
    validated_generation_args,
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


def test_request_body_is_a_bounded_json_object():
    parsed = parse_openai_request_body(b'{"messages":[]}', max_bytes=64)
    check("bounded object accepted", parsed == {"messages": []})
    for label, raw, limit in (
        ("empty rejected", b"", 64),
        ("array rejected", b"[]", 64),
        ("malformed rejected", b"not-json", 64),
        ("oversized rejected", b'{"messages":[]}', 4),
    ):
        try:
            parse_openai_request_body(raw, max_bytes=limit)
        except ValueError:
            check(label, True)
        else:
            check(label, False)


def test_generation_args_are_bounded():
    check(
        "default generation args accepted",
        validated_generation_args({"messages": []}, configured_max_tokens=512) == (0.0, 512),
    )
    for label, body in (
        ("missing messages rejected", {}),
        ("zero max_tokens rejected", {"messages": [], "max_tokens": 0}),
        ("negative max_tokens rejected", {"messages": [], "max_tokens": -1}),
        ("huge max_tokens rejected", {"messages": [], "max_tokens": 513}),
        ("boolean max_tokens rejected", {"messages": [], "max_tokens": True}),
        ("invalid temperature rejected", {"messages": [], "temperature": 3}),
        ("invalid tools rejected", {"messages": [], "tools": {}}),
        ("streaming rejected", {"messages": [], "stream": True}),
    ):
        try:
            validated_generation_args(body, configured_max_tokens=512)
        except ValueError:
            check(label, True)
        else:
            check(label, False)


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
    payload = build_chat_completion({"role": "assistant", "content": "hello"}, 100, 3, fr)
    check("payload choices[0].finish_reason present", payload["choices"][0]["finish_reason"] == "stop")
    check("payload content propagated", payload["choices"][0]["message"]["content"] == "hello")
    check("payload usage propagated",
          payload["usage"] == {"prompt_tokens": 100, "completion_tokens": 3})

    fr_len = normalize_finish_reason(stop_reason="length", completion_tokens=384, max_tokens=384)
    payload_len = build_chat_completion({"role": "assistant", "content": ""}, 100, 384, fr_len)
    check("length propagates into payload", payload_len["choices"][0]["finish_reason"] == "length")

    tool_message = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "type": "function",
            "id": "call_1",
            "function": {"name": "create-task", "arguments": '{"title":"A"}'},
        }],
    }
    payload_tool = build_chat_completion(tool_message, 100, 20, "stop")
    check(
        "tool calls propagate without text flattening",
        payload_tool["choices"][0]["message"] == tool_message,
    )
    check(
        "tool response uses tool_calls finish reason",
        payload_tool["choices"][0]["finish_reason"] == "tool_calls",
    )
    continuation = build_chat_completion(
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                tool_message["tool_calls"][0],
                {
                    "type": "function",
                    "id": "call_2",
                    "function": {"name": "finish-task", "arguments": '{"id":"A"}'},
                },
            ],
        },
        120,
        30,
        "stop",
    )
    check(
        "multiple continuation calls preserve tool_calls finish reason",
        continuation["choices"][0]["finish_reason"] == "tool_calls",
    )


def test_bearer_auth_is_fail_closed():
    check("missing expected token rejects", bearer_authorized("Bearer x", None) is False)
    check("missing header rejects", bearer_authorized(None, "secret") is False)
    check("wrong scheme rejects", bearer_authorized("Basic secret", "secret") is False)
    check("wrong token rejects", bearer_authorized("Bearer wrong", "secret") is False)
    check("matching token authorizes", bearer_authorized("Bearer secret", "secret") is True)


def test_parsed_tool_call_gets_stable_openai_shape():
    parsed = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "type": "function",
            "id": None,
            "function": {"name": "create-task", "arguments": {"title": "A"}},
        }],
    }
    first = normalize_assistant_message(parsed, "request-1")
    second = normalize_assistant_message(parsed, "request-1")
    check("missing tool id synthesized", first["tool_calls"][0]["id"].startswith("call_"))
    check("synthesized tool id stable", first == second)
    check(
        "tool arguments serialized as JSON string",
        first["tool_calls"][0]["function"]["arguments"] == '{"title": "A"}',
    )


def test_error_mapping_preserves_context_overflow_semantics():
    class BadRequestError(Exception):
        pass

    status, payload = openai_error_response(
        BadRequestError("Prompt length plus max_tokens exceeds the model's context window")
    )
    check("context overflow is HTTP 400", status == 400)
    check("context overflow has stable code", payload["error"]["code"] == "context_length_exceeded")
    status, payload = openai_error_response(TimeoutError("sampling timed out"))
    check("timeout is HTTP 504", status == 504)
    check("timeout is retry-class server error", payload["error"]["type"] == "server_error")


def main():
    tests = [
        test_request_body_is_a_bounded_json_object,
        test_generation_args_are_bounded,
        test_upstream_stop,
        test_upstream_length,
        test_absent_at_cap_infers_length,
        test_absent_under_cap_falls_back_stop,
        test_enum_shaped_terminations_map_to_stop,
        test_unknown_non_clean_termination_falls_through_to_cap,
        test_payload_requires_defined_finish_reason,
        test_bearer_auth_is_fail_closed,
        test_parsed_tool_call_gets_stable_openai_shape,
        test_error_mapping_preserves_context_overflow_semantics,
    ]
    for t in tests:
        print(t.__name__)
        t()
    print(f"\nALL {len(tests)} SHIM COMPAT TESTS PASSED")


if __name__ == "__main__":
    main()
