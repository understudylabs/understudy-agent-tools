#!/usr/bin/env python3
"""Minimal OpenAI-compatible /v1/chat/completions shim in front of a Tinker
sampling client, so the Node AutomationBench runner can score Tinker base models
without a dedicated deployment.

Tinker's `tools=` path raises NotImplementedError, so tool calls are driven
through plain sampling with the model's own renderer, exactly as the RL arms do.

  TINKER_API_KEY=... python scripts/tinker-openai-shim.py \
      --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 --port 8099
"""
from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tinker
from tinker_cookbook.renderers import get_renderer
from tinker_cookbook.tokenizer_utils import get_tokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--base-model", required=True)
parser.add_argument("--renderer", required=True)
parser.add_argument("--port", type=int, default=8099)
parser.add_argument("--max-tokens", type=int, default=512)
args = parser.parse_args()

service = tinker.ServiceClient()
sampler = service.create_sampling_client(base_model=args.base_model)
renderer = get_renderer(args.renderer, get_tokenizer(args.base_model))
pool = ThreadPoolExecutor(max_workers=16)


def sample(messages, temperature, max_tokens):
    prompt = renderer.build_generation_prompt([{"role": m["role"], "content": m["content"]} for m in messages])
    params = tinker.types.SamplingParams(
        max_tokens=max_tokens,
        temperature=temperature,
        stop=renderer.get_stop_sequences(),
    )
    result = sampler.sample(prompt=prompt, sampling_params=params, num_samples=1).result()
    tokens = result.sequences[0].tokens
    message, _termination = renderer.parse_response(tokens)
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or "", prompt.length, len(tokens)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep the console readable
        return

    def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        try:
            content, prompt_tokens, completion_tokens = pool.submit(
                sample,
                body["messages"],
                float(body.get("temperature", 0.0)),
                int(body.get("max_tokens", args.max_tokens)),
            ).result()
            payload = {
                "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
            }
            status = 200
        except Exception as error:  # surface upstream failures as HTTP errors
            payload = {"error": f"{type(error).__name__}: {error}"}
            status = 500
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


print(f"tinker shim on :{args.port} for {args.base_model} ({args.renderer})", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
