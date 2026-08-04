from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "tinker_openai_compat.py"
SPEC = importlib.util.spec_from_file_location("tinker_openai_compat", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_chat_completion_preserves_tool_calls() -> None:
    message = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "type": "function",
            "id": "call-1",
            "function": {"name": "create-task", "arguments": '{"title":"A"}'},
        }],
    }
    payload = MODULE.build_chat_completion(message, 10, 4, "stop")
    assert payload["choices"][0]["message"] == message


def test_parsed_tool_call_gets_stable_id_and_json_arguments() -> None:
    parsed = {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "type": "function",
            "id": None,
            "function": {"name": "create-task", "arguments": {"title": "A"}},
        }],
    }
    first = MODULE.normalize_assistant_message(parsed, "request-1")
    second = MODULE.normalize_assistant_message(parsed, "request-1")
    assert first == second
    assert first["tool_calls"][0]["id"].startswith("call_")
    assert first["tool_calls"][0]["function"]["arguments"] == '{"title": "A"}'


def test_typed_sdk_tool_call_is_normalized_without_private_attributes() -> None:
    @dataclass
    class Function:
        name: str
        arguments: str
        private_payload: str = "must-not-leak"

    @dataclass
    class ToolCall:
        id: str
        type: str
        function: Function
        private_payload: str = "must-not-leak"

    @dataclass
    class AssistantMessage:
        role: str
        content: str
        tool_calls: list[ToolCall]
        private_payload: str = "must-not-leak"

    normalized = MODULE.normalize_assistant_message(
        AssistantMessage(
            role="assistant",
            content="",
            tool_calls=[ToolCall("call-typed", "function", Function("create-task", '{"title":"A"}'))],
        ),
        "request-typed",
    )
    assert normalized == {
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": "call-typed",
            "type": "function",
            "function": {"name": "create-task", "arguments": '{"title":"A"}'},
        }],
    }
    assert "private_payload" not in str(normalized)


def test_pydantic_style_tool_call_is_normalized() -> None:
    class Model:
        def __init__(self, value):
            self.value = value
        def model_dump(self, *, mode):
            assert mode == "json"
            return self.value

    message = Model({
        "role": "assistant",
        "content": None,
        "tool_calls": [Model({
            "id": "call-model",
            "type": "function",
            "function": Model({"name": "lookup", "arguments": '{"x":1}'}),
        })],
    })
    normalized = MODULE.normalize_assistant_message(message, "request-model")
    assert normalized["tool_calls"][0]["function"] == {
        "name": "lookup", "arguments": '{"x":1}',
    }


def test_context_overflow_is_not_mislabeled_as_retryable_provider_failure() -> None:
    class BadRequestError(Exception):
        pass

    status, payload = MODULE.openai_error_response(
        BadRequestError("Prompt length plus max_tokens exceeds the model's context window")
    )
    assert status == 400
    assert payload["error"]["type"] == "invalid_request_error"
    assert payload["error"]["code"] == "context_length_exceeded"


def test_timeout_remains_a_retry_class_server_error() -> None:
    status, payload = MODULE.openai_error_response(TimeoutError("sampling timed out"))
    assert status == 504
    assert payload["error"]["code"] == "upstream_timeout"
