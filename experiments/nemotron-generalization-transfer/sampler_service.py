"""Small localhost Tinker sampling shim for the transfer harness."""

from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

import httpx
import tinker
from tinker import SamplingClient
from tinker_cookbook import renderers
from tinker_cookbook.renderers import get_text_content
from tinker_cookbook.tokenizer_utils import get_tokenizer

MODEL_NAME = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
DEFAULT_MAX_TOKENS = 192
DEFAULT_TEMPERATURE = 0.0
DEFAULT_RENDERER = "nemotron3_disable_thinking"
TINKER_BASE_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod"


def _client_config() -> dict[str, Any]:
    return {
        "credential_default_source": "api_key",
        "fwd_via_fwdbwd": True,
        "parallel_fwdbwd_chunks": True,
        "pjwt_auth_enabled": False,
        "proto_compress_fwdbwd": True,
        "proto_write_fwdbwd": True,
        "sample_max_concurrent_requests": 2000,
        "sample_no_retries": False,
        "use_pyqwest_transport": False,
    }


def _create_session() -> str:
    api_key = os.environ.get("TINKER_API_KEY")
    if not api_key:
        raise RuntimeError("TINKER_API_KEY is not set")
    base_url = os.environ.get("TINKER_BASE_URL", TINKER_BASE_URL).rstrip("/")
    response = httpx.post(
        f"{base_url}/api/v1/create_session",
        headers={"X-API-Key": api_key, "content-type": "application/json"},
        json={"tags": [], "user_metadata": {}, "sdk_version": tinker.__version__},
        timeout=30.0,
    )
    response.raise_for_status()
    session_id = response.json().get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise RuntimeError("Tinker create_session response did not contain session_id")
    return session_id


class Sampler:
    def __init__(self, base_model: str | None, model_path: str | None, renderer_name: str):
        self.base_model = base_model
        self.model_path = model_path
        self.renderer_name = renderer_name
        self.session_id = _create_session()
        self.service_client = tinker.ServiceClient(
            _client_config=_client_config(),
            session_id=self.session_id,
            timeout=30.0,
        )
        self.rest_client = self.service_client.create_rest_client()
        self.tokenizer = get_tokenizer(MODEL_NAME)
        self.renderer = renderers.get_renderer(
            renderer_name,
            self.tokenizer,
            model_name=MODEL_NAME,
        )
        if model_path:
            weights = self.rest_client.get_weights_info_by_tinker_path(model_path).result()
            self.weights_info = (
                weights.model_dump(mode="json")
                if hasattr(weights, "model_dump")
                else vars(weights)
            )
            self.sampling_client = SamplingClient.create(
                self.service_client.holder,
                model_path=model_path,
                sampling_session_id=self.session_id,
            ).result()
        else:
            self.weights_info = None
            self.sampling_client = SamplingClient.create(
                self.service_client.holder,
                base_model=base_model,
                sampling_session_id=self.session_id,
            ).result()

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "model": self.base_model if self.base_model else MODEL_NAME,
            "model_path": self.model_path,
            "renderer": self.renderer_name,
            "lora_rank": self.weights_info.get("lora_rank") if self.weights_info else None,
            "checkpoint_base_model": (
                self.weights_info.get("base_model") if self.weights_info else None
            ),
            "weights_info": self.weights_info,
            "sampling_defaults": {
                "temperature": DEFAULT_TEMPERATURE,
                "max_tokens": DEFAULT_MAX_TOKENS,
                "max_model_turns": 12,
            },
        }

    @staticmethod
    def _prompt_token_count(model_input: tinker.ModelInput) -> int:
        return sum(
            len(getattr(chunk, "tokens", []))
            for chunk in model_input.chunks
            if hasattr(chunk, "tokens")
        )

    def sample(self, messages: list[dict[str, str]], max_tokens: int, temperature: float) -> dict[str, Any]:
        model_input = self.renderer.build_generation_prompt(messages)
        response = self.sampling_client.sample(
            prompt=model_input,
            num_samples=1,
            sampling_params=tinker.SamplingParams(
                max_tokens=max_tokens,
                temperature=temperature,
                stop=self.renderer.get_stop_sequences(),
            ),
        ).result()
        sequence = response.sequences[0]
        assistant_message, termination = self.renderer.parse_response(sequence.tokens)
        return {
            "content": get_text_content(assistant_message),
            "usage": {
                "prompt": self._prompt_token_count(model_input),
                "completion": len(sequence.tokens),
            },
            "stop_reason": termination.value,
            "prompt_cache_hit_tokens": getattr(response, "prompt_cache_hit_tokens", 0),
        }


def _json_response(handler: BaseHTTPRequestHandler, body: object, status: int = 200) -> None:
    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def serve(sampler: Sampler, port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if urlparse(self.path).path == "/health":
                _json_response(self, sampler.health())
            else:
                _json_response(self, {"error": "not found"}, 404)

        def do_POST(self) -> None:
            if urlparse(self.path).path != "/sample":
                _json_response(self, {"error": "not found"}, 404)
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                body = json.loads(self.rfile.read(length))
                messages = body["messages"]
                max_tokens = int(body.get("max_tokens", DEFAULT_MAX_TOKENS))
                temperature = float(body.get("temperature", DEFAULT_TEMPERATURE))
                if not isinstance(messages, list):
                    raise ValueError("messages must be an array")
                _json_response(self, sampler.sample(messages, max_tokens, temperature))
            except Exception as error:
                _json_response(self, {"error": str(error)}, 400)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"health": sampler.health()}, separators=(",", ":")), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--base-model", default=None)
    group.add_argument("--model-path", default=None)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--renderer", default=DEFAULT_RENDERER)
    args = parser.parse_args()
    sampler = Sampler(args.base_model, args.model_path, args.renderer)
    serve(sampler, args.port)


if __name__ == "__main__":
    main()
