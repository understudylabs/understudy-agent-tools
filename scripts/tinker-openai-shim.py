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

from tinker_openai_compat import (
    InvalidRequestError,
    bearer_authorized,
    build_chat_completion,
    normalize_assistant_message,
    normalize_finish_reason,
    openai_error_response,
    parse_chat_request,
)
from tinker_renderer_compat import renderer_messages, renderer_tools

parser = argparse.ArgumentParser()
model_group = parser.add_mutually_exclusive_group(required=True)
model_group.add_argument("--base-model")
model_group.add_argument("--model-path", help="Tinker sampler-state/checkpoint path returned by save_weights_for_sampler().")
model_group.add_argument(
    "--model-registry-file",
    help="JSON object mapping public model aliases to Tinker checkpoint paths.",
)
parser.add_argument("--tokenizer-model", help="Base model used for tokenization/rendering when --model-path is selected.")
parser.add_argument("--renderer", required=True)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument(
    "--trusted-proxy-auth",
    action="store_true",
    help="Allow a non-loopback bind without app bearer auth only behind an authenticated reverse proxy.",
)
parser.add_argument("--port", type=int, default=8099)
parser.add_argument("--max-tokens", type=int, default=512)
parser.add_argument("--max-workers", type=int, default=16, help="in-flight samples; raise it for rollout mining")
args = parser.parse_args()
service_token = os.environ.get("TINKER_SHIM_BEARER_TOKEN")
trusted_modal_proxy = (
    args.trusted_proxy_auth
    and os.environ.get("TINKER_TRUSTED_PROXY_AUTH") == "modal"
    and bool(os.environ.get("MODAL_TASK_ID"))
)
if (
    args.host not in {"127.0.0.1", "::1", "localhost"}
    and not service_token
    and not trusted_modal_proxy
):
    raise SystemExit(
        "TINKER_SHIM_BEARER_TOKEN or an attested Modal proxy runtime is required for non-loopback binds"
    )
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
    # Modal's durable app logs are the only operator-visible surface for this
    # web-server process. Records contain request ids and bounded error types,
    # never prompts, tool arguments, credentials, or response text.
    print(json.dumps(record, sort_keys=True), flush=True)


service = tinker.ServiceClient(_client_config={"use_pyqwest_transport": False})
if args.model_registry_file:
    registry = json.loads(open(args.model_registry_file, encoding="utf-8").read())
    if not isinstance(registry, dict) or not registry or not all(
        isinstance(alias, str) and alias and isinstance(path, str) and path
        for alias, path in registry.items()
    ):
        raise SystemExit("--model-registry-file must contain a non-empty string-to-string JSON object")
    samplers = {
        alias: service.create_sampling_client(model_path=path)
        for alias, path in registry.items()
    }
elif args.model_path:
    samplers = {args.model_path: service.create_sampling_client(model_path=args.model_path)}
else:
    samplers = {args.base_model: service.create_sampling_client(base_model=args.base_model)}
tokenizer_model = args.tokenizer_model or args.base_model
if not tokenizer_model:
    raise SystemExit("--tokenizer-model is required with checkpoint paths")
renderer = get_renderer(args.renderer, get_tokenizer(tokenizer_model))
pool = ThreadPoolExecutor(max_workers=args.max_workers)
served_models = sorted(samplers)


def sample(model, messages, tools, temperature, max_tokens):
    system_prompt, conversation = renderer_messages(messages)
    tool_specs = renderer_tools(tools)
    prefix = renderer.create_conversation_prefix_with_tools(
        tool_specs,
        system_prompt=system_prompt,
    )
    prompt = renderer.build_generation_prompt([*prefix, *conversation])
    params = tinker.types.SamplingParams(
        max_tokens=max_tokens,
        temperature=temperature,
        stop=renderer.get_stop_sequences(),
    )
    result = samplers[model].sample(prompt=prompt, sampling_params=params, num_samples=1).result()
    sequence = result.sequences[0]
    tokens = sequence.tokens
    message, termination = renderer.parse_response(tokens)
    openai_message = renderer.to_openai_message(message)
    finish_reason = normalize_finish_reason(
        stop_reason=sequence.stop_reason,
        termination=getattr(termination, "value", termination),
        completion_tokens=len(tokens),
        max_tokens=max_tokens,
    )
    return openai_message, prompt.length, len(tokens), finish_reason


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep the console readable
        return

    def _send_json(self, status, payload):
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except BrokenPipeError:
            pass

    def _authorized(self):
        # Loopback remains usable for local provider-parity tests. Any
        # network-facing bind is already required to configure a token.
        if not service_token:
            return True
        return bearer_authorized(self.headers.get("authorization"), service_token)

    def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        if not self._authorized():
            self._send_json(401, {"error": {"message": "unauthorized", "type": "authentication_error"}})
            return
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "models": served_models})
            return
        if self.path == "/v1/models":
            self._send_json(
                200,
                {"object": "list", "data": [{"id": model, "object": "model"} for model in served_models]},
            )
            return
        self._send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        global active_requests
        if not self._authorized():
            self._send_json(401, {"error": {"message": "unauthorized", "type": "authentication_error"}})
            return
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return
        request_id = self.headers.get("x-request-id") or str(uuid.uuid4())
        started = time.monotonic()
        with active_lock:
            active_requests += 1
            in_flight = active_requests
        log_event("start", request_id=request_id, in_flight=in_flight)
        try:
            raw_content_length = self.headers.get("content-length")
            if raw_content_length is None:
                raise InvalidRequestError("content-length header is required")
            try:
                content_length = int(raw_content_length)
            except ValueError as error:
                raise InvalidRequestError("content-length header must be an integer") from error
            if content_length < 0:
                raise InvalidRequestError("content-length header must be non-negative")
            body = parse_chat_request(self.rfile.read(content_length))
            requested_model = body.get("model")
            if requested_model is None and len(served_models) == 1:
                requested_model = served_models[0]
            if requested_model not in samplers:
                self._send_json(
                    400,
                    {"error": {"message": "unknown model", "type": "invalid_request_error"}},
                )
                return
            for attempt in range(2):
                try:
                    message, prompt_tokens, completion_tokens, finish_reason = pool.submit(
                        sample,
                        requested_model,
                        body["messages"],
                        body.get("tools") or [],
                        float(body.get("temperature", 0.0)),
                        int(body.get("max_tokens", args.max_tokens)),
                    ).result(timeout=request_timeout)
                    break
                except FutureTimeoutError:
                    log_event("timeout", request_id=request_id, attempt=attempt + 1, seconds=request_timeout)
                    if attempt == 1:
                        raise TimeoutError(f"sampling exceeded {request_timeout}s twice")
                    log_event("retry", request_id=request_id, attempt=attempt + 2)
            message = normalize_assistant_message(message, request_id)
            if message.get("tool_calls"):
                finish_reason = "tool_calls"
            payload = build_chat_completion(
                message,
                prompt_tokens,
                completion_tokens,
                finish_reason,
                model=requested_model,
                request_id=request_id,
            )
            status = 200
        except Exception as error:  # surface upstream failures as HTTP errors
            log_event("error", request_id=request_id, error=type(error).__name__)
            status, payload = openai_error_response(error)
        finally:
            elapsed = time.monotonic() - started
            with active_lock:
                active_requests -= 1
                in_flight = active_requests
            log_event("done", request_id=request_id, elapsed_seconds=round(elapsed, 3), in_flight=in_flight)
        self._send_json(status, payload)


print(f"tinker shim on {args.host}:{args.port} for {served_models} ({args.renderer})", flush=True)
ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
