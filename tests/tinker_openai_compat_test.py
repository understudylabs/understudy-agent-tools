import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "tinker_openai_compat.py"
SPEC = importlib.util.spec_from_file_location("tinker_openai_compat", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Renderer:
    def create_conversation_prefix_with_tools(self, tools, system_prompt=""):
        return [
            {
                "role": "system",
                "content": f"{system_prompt}|tools={tools[0]['name']}",
            }
        ]


def test_renderer_messages_preserves_tool_history_and_schema():
    messages = [
        {"role": "system", "content": "Use the calendar."},
        {"role": "user", "content": "Find tomorrow's events."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "call-1",
                    "function": {
                        "name": "list-events",
                        "arguments": '{"day":"tomorrow"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": '{"events":[]}'},
    ]
    tools = [
        {
            "type": "function",
            "function": {
                "name": "list-events",
                "description": "List events.",
                "parameters": {"type": "object"},
            },
        }
    ]

    rendered = MODULE.renderer_messages(Renderer(), messages, tools)

    assert rendered[0]["content"].endswith("|tools=list-events")
    assert rendered[1:] == messages[1:]
    assert rendered[2]["tool_calls"][0]["id"] == "call-1"
    assert rendered[3]["tool_call_id"] == "call-1"


def test_build_chat_completion_preserves_openai_tool_calls():
    payload = MODULE.build_chat_completion(
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "id": "call-1",
                    "function": {"name": "list-events", "arguments": "{}"},
                }
            ],
        },
        10,
        4,
        "stop",
    )

    assert payload["choices"][0]["message"]["tool_calls"][0]["id"] == "call-1"
