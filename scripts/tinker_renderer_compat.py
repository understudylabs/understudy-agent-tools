#!/usr/bin/env python3
"""OpenAI-to-Tinker renderer conversion for faithful multi-turn tool use."""
from __future__ import annotations

import json

from tinker_cookbook.renderers.base import Message, ToolCall, ToolSpec


def _message_text(content: object) -> str:
    """Normalize OpenAI text content without silently dropping non-text parts."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise ValueError("message content must be string, null, or a text-part array")

    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") not in {"text", "input_text"}:
            raise ValueError("only text/input_text message content parts are supported")
        text = part.get("text")
        if not isinstance(text, str):
            raise ValueError("message text content part requires a string text field")
        parts.append(text)
    return "".join(parts)


def renderer_messages(messages: list[dict]) -> tuple[str, list[Message]]:
    """Losslessly convert OpenAI history into the cookbook renderer contract."""
    system_parts: list[str] = []
    converted: list[Message] = []
    for raw in messages:
        role = raw.get("role")
        content = _message_text(raw.get("content"))
        if role == "system":
            system_parts.append(content)
            continue
        if role not in {"user", "assistant", "tool"}:
            raise ValueError(f"unsupported message role: {role!r}")
        message: Message = {"role": role, "content": content}
        if role == "assistant" and raw.get("tool_calls"):
            calls: list[ToolCall] = []
            for raw_call in raw["tool_calls"]:
                function = raw_call.get("function") or {}
                arguments = function.get("arguments", "{}")
                if isinstance(arguments, dict):
                    arguments = json.dumps(arguments, sort_keys=True)
                if not isinstance(arguments, str):
                    raise ValueError("tool call arguments must be a JSON string or object")
                json.loads(arguments)
                calls.append(
                    ToolCall(
                        id=raw_call.get("id"),
                        function=ToolCall.FunctionBody(
                            name=function["name"],
                            arguments=arguments,
                        ),
                    )
                )
            message["tool_calls"] = calls
        if role == "tool":
            if not raw.get("tool_call_id"):
                raise ValueError("tool result requires tool_call_id")
            message["tool_call_id"] = raw["tool_call_id"]
            if raw.get("name"):
                message["name"] = raw["name"]
        converted.append(message)
    return "\n\n".join(system_parts), converted


def renderer_tools(tools: list[dict]) -> list[ToolSpec]:
    """Convert OpenAI function-tool declarations to cookbook ToolSpec values."""
    converted: list[ToolSpec] = []
    for raw in tools:
        if raw.get("type") != "function" or not isinstance(raw.get("function"), dict):
            raise ValueError("only OpenAI function tools are supported")
        function = raw["function"]
        converted.append(
            {
                "name": function["name"],
                "description": function.get("description") or "",
                "parameters": function.get("parameters")
                or {"type": "object", "properties": {}},
            }
        )
    return converted
