#!/usr/bin/env python3
"""OpenAI-compatible local sampler for the Fireworks serverless Qwen lane."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_contract(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        contract = json.load(handle)
    if contract["protocol_sha256"] == "TO_BE_FILLED_BY_PROTOCOL_EXPORT":
        raise RuntimeError("serving contract protocol_sha256 is not populated")
    return contract


def token_ids(value):
    if hasattr(value, "input_ids"):
        value = value.input_ids
    elif isinstance(value, dict):
        value = value["input_ids"]
    if value and isinstance(value[0], list):
        value = value[0]
    return [int(item) for item in value]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default=None)
    parser.add_argument("--tokenizer", default=None)
    parser.add_argument("--model-path", default=None)
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument(
        "--contract",
        default=os.path.join(os.path.dirname(__file__), "serving-contract.qwen3p6-27b.json"),
    )
    args = parser.parse_args()
    contract = load_contract(args.contract)
    base_model = args.base_model or contract["base_model"]
    tokenizer_id = args.tokenizer or contract["tokenizer"]
    max_tokens = args.max_tokens or int(contract["max_tokens"])

    from transformers import AutoTokenizer
    import tinker
    from fireworks.training.sdk import FiretitanServiceClient

    tokenizer = AutoTokenizer.from_pretrained(tokenizer_id, token=os.environ.get("HF_TOKEN"))
    template_hash = hashlib.sha256((tokenizer.chat_template or "").encode()).hexdigest()
    if template_hash != contract["chat_template_sha256"]:
        raise RuntimeError(f"chat template hash mismatch: {template_hash}")
    service = FiretitanServiceClient(
        api_key=os.environ["FIREWORKS_API_KEY"],
        base_url=os.environ.get("FIREWORKS_BASE_URL", "https://api.fireworks.ai").rstrip("/")
        + "/training/v1/serverless",
    )
    training_client = None
    model_path = args.model_path
    if model_path is None:
        training_client = service.create_lora_training_client(base_model=base_model, rank=args.lora_rank)
        model_path = training_client.save_weights_for_sampler("verifier-rl-base").result().path
    sampler = service.create_sampling_client(model_path=model_path, tokenizer=tokenizer)

    def sample(body: dict) -> dict:
        messages = body.get("messages") or []
        prompt_ids = token_ids(tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
        ))
        prompt = tinker.ModelInput(chunks=[tinker.EncodedTextChunk(tokens=prompt_ids)])
        params = tinker.SamplingParams(
            max_tokens=int(body.get("max_tokens", max_tokens)),
            temperature=float(body.get("temperature", contract["temperature"])),
            stop=contract["stop_sequences"],
        )
        result = sampler.sample(prompt=prompt, num_samples=1, sampling_params=params).result()
        tokens = list(result.sequences[0].tokens)
        content = tokenizer.decode(tokens, skip_special_tokens=True)
        return {
            "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": len(prompt_ids),
                "completion_tokens": len(tokens),
                "total_tokens": len(prompt_ids) + len(tokens),
            },
        }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                payload = {"ok": True, "model_path": model_path}
                encoded = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            self.send_error(404)

        def do_POST(self):  # noqa: N802
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            try:
                size = int(self.headers.get("content-length", "0"))
                payload = sample(json.loads(self.rfile.read(size)))
                encoded = json.dumps(payload).encode()
                self.send_response(200)
            except Exception as error:  # noqa: BLE001
                encoded = json.dumps({"error": f"{type(error).__name__}: {error}"}).encode()
                self.send_response(500)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    try:
        print(json.dumps({"event": "ready", "port": args.port, "model_path": model_path}), flush=True)
        server.serve_forever()
    finally:
        server.server_close()
        sampler.close()
        if training_client is not None and hasattr(training_client, "close"):
            training_client.close()
        service.close()


if __name__ == "__main__":
    main()
