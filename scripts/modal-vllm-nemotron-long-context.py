"""Modal H200 deployment for hash-bound Nemotron long-context artifacts.

The model volume must already contain an export receipt and artifact produced by
`export-tinker-nemotron-long-context.py`.  This file does not upload artifacts.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import modal

from nemotron_long_context_contract import (
    BASE_MODEL,
    BASE_REVISION,
    MAX_MODEL_LEN,
    REASONING_PARSER,
    REASONING_PARSER_PLUGIN,
    REASONING_PARSER_PLUGIN_SHA256,
    REASONING_PARSER_PLUGIN_URL,
    TOOL_CALL_PARSER,
    safe_artifact_path,
    sha256_tree,
    validate_export_receipt,
)


APP_NAME = "understudy-nemotron-long-context"
VLLM_IMAGE = "vllm/vllm-openai:v0.26.0"
PORT = 8000
MODEL_VOLUME_NAME = "understudy-nemotron-long-context-models"
ARTIFACT_SECRET_NAME = "understudy-nemotron-long-context-serving"
MODEL_ROOT = Path("/models")
SCALEDOWN_WINDOW_SECONDS = 300
FUNCTION_TIMEOUT_SECONDS = 2 * 60 * 60

app = modal.App(APP_NAME)
models = modal.Volume.from_name(MODEL_VOLUME_NAME, create_if_missing=False)
image = (
    modal.Image.from_registry(VLLM_IMAGE, add_python="3.12")
    .entrypoint([])
    .env({"PYTHONPATH": "/opt/understudy"})
    .add_local_file(
        "scripts/nemotron_long_context_contract.py",
        "/opt/understudy/nemotron_long_context_contract.py",
        copy=True,
    )
    .run_commands(
        "python -c \"import hashlib,urllib.request; "
        f"data=urllib.request.urlopen('{REASONING_PARSER_PLUGIN_URL}').read(); "
        f"assert hashlib.sha256(data).hexdigest() == '{REASONING_PARSER_PLUGIN_SHA256}'; "
        f"open('{REASONING_PARSER_PLUGIN}','wb').write(data)\""
    )
)


def build_vllm_command(artifact_id: str, receipt: dict) -> list[str]:
    validate_export_receipt(receipt)
    artifact_dir = safe_artifact_path(MODEL_ROOT, artifact_id)
    expected_sha = receipt["artifact"]["sha256"]
    actual_sha, _ = sha256_tree(artifact_dir, exclude={"export-receipt.json"})
    if actual_sha != expected_sha:
        raise ValueError("mounted serving artifact hash does not match export receipt")
    kind = receipt["selection"]["artifact_kind"]
    if kind == "merged-hf":
        model = str(artifact_dir)
        command = ["vllm", "serve", model]
    elif kind == "peft-lora":
        if not receipt["inspection"]["multi_lora_faithful"]:
            raise ValueError("unfaithful adapter cannot be hot-loaded")
        model = BASE_MODEL
        command = [
            "vllm", "serve", model,
            "--revision", BASE_REVISION,
            "--enable-lora",
            "--max-loras", "4",
            "--max-lora-rank", "64",
            "--lora-modules", f"{artifact_id}={artifact_dir}",
        ]
    else:
        raise ValueError("unsupported serving artifact kind")
    command.extend([
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--served-model-name", artifact_id,
        "--tokenizer", BASE_MODEL,
        "--tokenizer-revision", BASE_REVISION,
        "--dtype", "bfloat16",
        "--trust-remote-code",
        "--max-model-len", str(MAX_MODEL_LEN),
        "--enable-prefix-caching",
        "--enable-auto-tool-choice",
        "--reasoning-parser", REASONING_PARSER,
        "--reasoning-parser-plugin", REASONING_PARSER_PLUGIN,
        "--tool-call-parser", TOOL_CALL_PARSER,
    ])
    # Deliberately absent: --truncate-prompt-tokens and application API keys.
    return command


@app.function(
    image=image,
    gpu="H200",
    volumes={str(MODEL_ROOT): models},
    scaledown_window=SCALEDOWN_WINDOW_SECONDS,
    timeout=FUNCTION_TIMEOUT_SECONDS,
    max_containers=1,
    secrets=[modal.Secret.from_name(ARTIFACT_SECRET_NAME)],
)
@modal.web_server(PORT, startup_timeout=45 * 60, requires_proxy_auth=True)
def serve() -> None:
    artifact_id = os.environ.get("UNDERSTUDY_NEMOTRON_ARTIFACT_ID", "").strip()
    artifact_dir = safe_artifact_path(MODEL_ROOT, artifact_id)
    receipt_path = artifact_dir / "export-receipt.json"
    if not receipt_path.is_file():
        raise RuntimeError("mounted artifact has no export receipt")
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    subprocess.Popen(build_vllm_command(artifact_id, receipt), env=os.environ.copy())
