#!/usr/bin/env python3
"""Capability probe for the multi-base bake-off.

For each candidate base, confirm the Tinker lane can (a) build a renderer,
(b) sample under the bake-off serving contract, and (c) return a parseable
single-JSON tool call. Prints one row per (base, renderer) with first-token
wall clock, so an unusable base is dropped before any training spend.

  TINKER_API_KEY=... python experiments/multi-base-bakeoff/probe-bases.py
"""
from __future__ import annotations

import argparse
import json
import os
import time

if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
    import httpx
    import tinker._base_client as _tinker_base_client

    _tinker_base_client._default_pyqwest_transport = lambda: httpx.AsyncHTTPTransport(retries=2)

import tinker  # noqa: E402
from tinker_cookbook.renderers import get_renderer  # noqa: E402
from tinker_cookbook.tokenizer_utils import get_tokenizer  # noqa: E402

CANDIDATES = [
    ("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16", ["nemotron3", "nemotron3_disable_thinking"]),
    ("Qwen/Qwen3.6-27B", ["qwen3_5_disable_thinking", "qwen3_5", "qwen3_instruct", "qwen3_disable_thinking"]),
    ("Qwen/Qwen3.5-9B", ["qwen3_5_disable_thinking", "qwen3_5", "qwen3_instruct", "qwen3_disable_thinking"]),
]

SYSTEM = "\n".join([
    "You operate business apps through two tools.",
    'api_search — read-only endpoint discovery. arguments: {"query": string}',
    'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
    "",
    "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
    '  {"tool": "api_search", "arguments": {"query": "..."}}',
    '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
    '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
    "",
    "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
    "Writing to a record the request did not ask you to change scores zero for the whole task.",
])
USER = "Mark the deal with Evelyn Boyd as won."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-tokens", type=int, default=2000)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    service = tinker.ServiceClient()
    rows = []
    for base, renderers in CANDIDATES:
        for renderer_name in renderers:
            row = {"base_model": base, "renderer": renderer_name}
            try:
                renderer = get_renderer(renderer_name, get_tokenizer(base))
                sampler = service.create_sampling_client(base_model=base)
                prompt = renderer.build_generation_prompt(
                    [{"role": "system", "content": SYSTEM}, {"role": "user", "content": USER}]
                )
                started = time.time()
                result = sampler.sample(
                    prompt=prompt,
                    sampling_params=tinker.types.SamplingParams(
                        max_tokens=args.max_tokens, temperature=0.0, stop=renderer.get_stop_sequences()
                    ),
                    num_samples=1,
                ).result()
                tokens = result.sequences[0].tokens
                message, _ = renderer.parse_response(tokens)
                content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
                if isinstance(content, list):
                    content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
                row.update(
                    ok=True,
                    latency_s=round(time.time() - started, 2),
                    prompt_tokens=prompt.length,
                    completion_tokens=len(tokens),
                    reply=(content or "")[-400:],
                )
            except Exception as error:  # a base that cannot sample is out of the bake-off
                row.update(ok=False, error=f"{type(error).__name__}: {str(error)[:300]}")
            rows.append(row)
            print(json.dumps(row), flush=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(rows, indent=2) + "\n")


main()
