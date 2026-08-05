"""Private multi-checkpoint Tinker sampling bridge for Understudy Gateway.

Deploy with a Modal secret containing TINKER_API_KEY and
TINKER_MODEL_REGISTRY_JSON. Set TINKER_SERVING_APP_NAME and
TINKER_SERVING_SECRET_NAME at deploy time to isolate checkpoint lineages.

For a new private checkpoint, reuse an existing API-key secret without reading
it back by setting TINKER_SERVING_API_SECRET_NAME, and pass the checkpoint-only
registry in TINKER_SERVING_REGISTRY_JSON. The latter is converted to a Modal
Secret at deploy time and must never be committed or printed. Modal proxy
authentication is required before requests reach the shim.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import modal

APP_NAME = os.environ.get(
    "TINKER_SERVING_APP_NAME", "understudy-tinker-cedar-seed37-serving"
)
PORT = 8099
SECRET_NAME = os.environ.get(
    "TINKER_SERVING_SECRET_NAME", "understudy-tinker-serving-seed37"
)
API_SECRET_NAME = os.environ.get("TINKER_SERVING_API_SECRET_NAME", SECRET_NAME)
registry_override = os.environ.get("TINKER_SERVING_REGISTRY_JSON")
runtime_secrets = [modal.Secret.from_name(API_SECRET_NAME)]
if registry_override:
    # The checkpoint registry is supplied only to Modal's encrypted secret
    # plane at deploy time. It never enters Git, the image, or app logs, and it
    # can reuse an existing TINKER_API_KEY secret without copying that key back
    # to the operator workstation.
    runtime_secrets.append(
        modal.Secret.from_dict(
            {"TINKER_MODEL_REGISTRY_JSON_OVERRIDE": registry_override}
        )
    )
BASE_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
TINKER_VERSION = "0.24.0"
COOKBOOK_VERSION = "0.5.3"

app = modal.App(APP_NAME)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        f"tinker=={TINKER_VERSION}",
        f"tinker-cookbook=={COOKBOOK_VERSION}",
        "httpx>=0.27,<1",
    )
    .add_local_file("scripts/tinker-openai-shim.py", "/opt/understudy/tinker-openai-shim.py")
    .add_local_file("scripts/tinker_openai_compat.py", "/opt/understudy/tinker_openai_compat.py")
    .add_local_file("scripts/tinker_renderer_compat.py", "/opt/understudy/tinker_renderer_compat.py")
)


@app.function(
    image=image,
    secrets=runtime_secrets,
    timeout=60 * 60,
    scaledown_window=300,
    max_containers=4,
)
@modal.concurrent(max_inputs=64)
@modal.web_server(PORT, startup_timeout=10 * 60, requires_proxy_auth=True)
def serve() -> None:
    registry = json.loads(
        os.environ.get("TINKER_MODEL_REGISTRY_JSON_OVERRIDE")
        or os.environ["TINKER_MODEL_REGISTRY_JSON"]
    )
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
            "nemotron3_disable_thinking",
            "--host",
            "0.0.0.0",
            "--trusted-proxy-auth",
            "--port",
            str(PORT),
            "--max-workers",
            "64",
            "--max-tokens",
            "2048",
        ],
        env={**os.environ, "TINKER_TRUSTED_PROXY_AUTH": "modal"},
    )
