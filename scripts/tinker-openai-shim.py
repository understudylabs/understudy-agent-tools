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
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
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

from tinker_openai_compat import build_chat_completion, normalize_finish_reason

parser = argparse.ArgumentParser()
model_group = parser.add_mutually_exclusive_group(required=True)
model_group.add_argument("--base-model")
model_group.add_argument("--model-path", help="Tinker sampler-state/checkpoint path returned by save_weights_for_sampler().")
parser.add_argument("--tokenizer-model", help="Base model used for tokenization/rendering when --model-path is selected.")
parser.add_argument("--renderer", required=True)
parser.add_argument("--port", type=int, default=8099)
parser.add_argument("--max-tokens", type=int, default=512)
parser.add_argument("--max-workers", type=int, default=16, help="in-flight samples; raise it for rollout mining")
args = parser.parse_args()
request_timeout = 300
log_path = os.environ.get("TINKER_SHIM_LOG", "/tmp/tinker-openai-shim.log")
log_lock = threading.Lock()
active_lock = threading.Lock()
active_requests = 0


def log_event(event, **fields):
    record = {"ts": time.time(), "event": event, **fields}
    with log_lock:
        with open(log_path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")


service = tinker.ServiceClient(_client_config={"use_pyqwest_transport": False})
sampler = (
    service.create_sampling_client(model_path=args.model_path)
    if args.model_path
    else service.create_sampling_client(base_model=args.base_model)
)
tokenizer_model = args.tokenizer_model or args.base_model
if not tokenizer_model:
    raise SystemExit("--tokenizer-model is required with --model-path")
renderer = get_renderer(args.renderer, get_tokenizer(tokenizer_model))
pool = ThreadPoolExecutor(max_workers=args.max_workers)


def sample(messages, temperature, max_tokens):
    prompt = renderer.build_generation_prompt([{"role": m["role"], "content": m["content"]} for m in messages])
    params = tinker.types.SamplingParams(
        max_tokens=max_tokens,
        temperature=temperature,
        stop=renderer.get_stop_sequences(),
    )
    result = sampler.sample(prompt=prompt, sampling_params=params, num_samples=1).result()
    sequence = result.sequences[0]
    tokens = sequence.tokens
    message, termination = renderer.parse_response(tokens)
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    finish_reason = normalize_finish_reason(
        stop_reason=sequence.stop_reason,
        termination=getattr(termination, "value", termination),
        completion_tokens=len(tokens),
        max_tokens=max_tokens,
    )
    return content or "", prompt.length, len(tokens), finish_reason


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep the console readable
        return

    def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        global active_requests
        request_id = self.headers.get("x-request-id") or str(uuid.uuid4())
        started = time.monotonic()
        with active_lock:
            active_requests += 1
            in_flight = active_requests
        log_event("start", request_id=request_id, in_flight=in_flight)
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        try:
            for attempt in range(2):
                try:
                    content, prompt_tokens, completion_tokens, finish_reason = pool.submit(
                        sample,
                        body["messages"],
                        float(body.get("temperature", 0.0)),
                        int(body.get("max_tokens", args.max_tokens)),
                    ).result(timeout=request_timeout)
                    break
                except FutureTimeoutError:
                    log_event("timeout", request_id=request_id, attempt=attempt + 1, seconds=request_timeout)
                    if attempt == 1:
                        raise TimeoutError(f"sampling exceeded {request_timeout}s twice")
                    log_event("retry", request_id=request_id, attempt=attempt + 2)
            payload = build_chat_completion(content, prompt_tokens, completion_tokens, finish_reason)
            status = 200
        except Exception as error:  # surface upstream failures as HTTP errors
            log_event("error", request_id=request_id, error=type(error).__name__, detail=str(error)[:240])
            payload = {"error": f"{type(error).__name__}: {error}"}
            status = 500
        finally:
            elapsed = time.monotonic() - started
            with active_lock:
                active_requests -= 1
                in_flight = active_requests
            log_event("done", request_id=request_id, elapsed_seconds=round(elapsed, 3), in_flight=in_flight)
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except BrokenPipeError:
            pass


print(f"tinker shim on :{args.port} for {args.base_model} ({args.renderer})", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
