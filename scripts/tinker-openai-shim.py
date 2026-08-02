#!/usr/bin/env python3
"""Minimal OpenAI-compatible /v1/chat/completions shim in front of a Tinker
sampling client, so the Node AutomationBench runner can score Tinker base models
and Tinker-trained checkpoints without a dedicated deployment.

Tinker's `tools=` path raises NotImplementedError, so tool calls are driven
through plain sampling with the model's own renderer, exactly as the RL arms do.

  TINKER_API_KEY=... python scripts/tinker-openai-shim.py \
      --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 --renderer nemotron3 --port 8099

Pass `--model-path tinker://...` to serve a trained checkpoint (a LoRA adapter
over the same base) instead of the base weights; everything else is unchanged,
so base and tuned runs are scored through one identical sampling path.
"""
from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# pyqwest (the Rust HTTP backend tinker prefers) carries its own root store and
# rejects otherwise-valid certificates on some Linux hosts. Opt in to httpx's
# system trust store when that happens; the wire protocol is identical.
if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
    import httpx
    import tinker._base_client as _tinker_base_client

    _tinker_base_client._default_pyqwest_transport = lambda: httpx.AsyncHTTPTransport(retries=2)

import tinker
from tinker_cookbook.renderers import get_renderer
from tinker_cookbook.tokenizer_utils import get_tokenizer

parser = argparse.ArgumentParser()
parser.add_argument("--base-model", required=True)
parser.add_argument("--renderer", required=True)
parser.add_argument("--model-path", default=None, help="tinker:// checkpoint to serve over the base weights")
parser.add_argument("--port", type=int, default=8099)
parser.add_argument("--max-tokens", type=int, default=512)
args = parser.parse_args()

service = tinker.ServiceClient()
sampler = (
    service.create_sampling_client(model_path=args.model_path, base_model=args.base_model)
    if args.model_path
    else service.create_sampling_client(base_model=args.base_model)
)
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
