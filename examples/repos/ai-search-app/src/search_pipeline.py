from __future__ import annotations

import time


SYSTEM_PROMPT = """You are a travel search assistant.
Return concise ranked hotel neighborhoods with reasons and tradeoffs.
"""


def build_messages(query: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": query},
    ]


def search_hotels(client, query: str) -> dict[str, object]:
    start = time.perf_counter()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=build_messages(query),
        temperature=0.2,
    )
    elapsed_ms = round((time.perf_counter() - start) * 1000)
    return {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "latency_ms": elapsed_ms,
        "input_tokens": getattr(response.usage, "prompt_tokens", None),
        "output_tokens": getattr(response.usage, "completion_tokens", None),
        "answer": response.choices[0].message.content,
    }
