from __future__ import annotations

import importlib.util
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
