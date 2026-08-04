"""Private multi-checkpoint Tinker sampling bridge for Understudy Gateway.

Deploy with a Modal secret named understudy-tinker-serving containing
TINKER_API_KEY, TINKER_SHIM_BEARER_TOKEN, and TINKER_MODEL_REGISTRY_JSON.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import modal

APP_NAME = "understudy-tinker-checkpoint-serving"
PORT = 8099
SECRET_NAME = "understudy-tinker-serving"
BASE_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
TINKER_COMMIT = "3eb9e87d52efacede992931b1bb51d000b0c70ed"
COOKBOOK_COMMIT = "0b5c01eaee49bdb0d476f4f383e1c0fb9aced590"

app = modal.App(APP_NAME)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        f"tinker @ git+https://github.com/thinking-machines-lab/tinker.git@{TINKER_COMMIT}",
        f"tinker-cookbook @ git+https://github.com/thinking-machines-lab/tinker-cookbook.git@{COOKBOOK_COMMIT}",
        "httpx>=0.27,<1",
    )
    .add_local_file("scripts/tinker-openai-shim.py", "/opt/understudy/tinker-openai-shim.py")
    .add_local_file("scripts/tinker_openai_compat.py", "/opt/understudy/tinker_openai_compat.py")
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    timeout=60 * 60,
    scaledown_window=300,
    max_containers=4,
)
@modal.concurrent(max_inputs=64)
@modal.web_server(PORT, startup_timeout=10 * 60)
def serve() -> None:
    registry = json.loads(os.environ["TINKER_MODEL_REGISTRY_JSON"])
    if not isinstance(registry, dict) or not registry:
        raise RuntimeError("TINKER_MODEL_REGISTRY_JSON must be a non-empty object")
    registry_path = Path("/tmp/tinker-model-registry.json")
    registry_path.write_text(json.dumps(registry, sort_keys=True), encoding="utf-8")
    registry_path.chmod(0o600)
    subprocess.Popen(
        [
            "python",
            "/opt/understudy/tinker-openai-shim.py",
            "--model-registry-file",
            str(registry_path),
            "--tokenizer-model",
            BASE_MODEL,
            "--renderer",
            "nemotron3",
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            "--max-workers",
            "64",
            "--max-tokens",
            "2048",
        ],
        env=os.environ.copy(),
    )
