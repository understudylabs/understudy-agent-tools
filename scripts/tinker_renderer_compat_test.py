#!/usr/bin/env python3
"""Provider-free exact Nemotron renderer roundtrip for tool-capable serving."""
from __future__ import annotations

from tinker_cookbook.renderers import get_renderer
from tinker_cookbook.tokenizer_utils import get_tokenizer

from tinker_openai_compat import normalize_assistant_message
from tinker_renderer_compat import renderer_messages, renderer_tools

MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"


def main() -> None:
    tokenizer = get_tokenizer(MODEL)
    renderer = get_renderer("nemotron3_disable_thinking", tokenizer)
    tools = [{
        "type": "function",
        "function": {
            "name": "create-task",
            "description": "Create a task",
            "parameters": {
                "type": "object",
                "properties": {"title": {"type": "string"}},
                "required": ["title"],
            },
        },
    }]
    messages = [
        {"role": "system", "content": "Operate Cedar faithfully."},
        {"role": "user", "content": "Create task A."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "type": "function",
                "id": "call_prior",
                "function": {"name": "create-task", "arguments": '{"title":"A"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "call_prior", "content": '{"success":true}'},
        {"role": "user", "content": "Continue."},
    ]
    system, history = renderer_messages(messages)
    prefix = renderer.create_conversation_prefix_with_tools(renderer_tools(tools), system)
    prompt = renderer.build_generation_prompt([*prefix, *history])
    assert prompt.length > 0
    decoded = tokenizer.decode(prompt.to_ints())
    assert "create-task" in decoded
    assert "Create task A." in decoded
    assert "<tool_response>" in decoded
    assert '{"success":true}' in decoded

    sampled = tokenizer.encode(
        "<tool_call>\n<function=create-task>\n<parameter=title>\nA\n"
        "</parameter>\n</function>\n</tool_call>\n<|im_end|>",
        add_special_tokens=False,
    )
    parsed, termination = renderer.parse_response(sampled)
    assert str(termination) == "stop_sequence"
    openai = normalize_assistant_message(renderer.to_openai_message(parsed), "probe-request")
    call = openai["tool_calls"][0]
    assert call["id"].startswith("call_")
    assert call["function"]["name"] == "create-task"
    assert call["function"]["arguments"] == '{"title": "A"}'
    print("EXACT NEMOTRON TOOL ROUNDTRIP PASSED")


if __name__ == "__main__":
    main()
