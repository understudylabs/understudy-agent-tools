"""Build a pinned merged-HF Nemotron artifact directly between Modal Volumes.

This is a storage/CPU operation. It does not train, sample, evaluate, or access
DEV/holdout data. The source is an already-exported Tinker sampler adapter.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import modal

from nemotron_long_context_contract import (
    BASE_MODEL,
    BASE_REVISION,
    EXPORT_SCHEMA,
    MAX_MODEL_LEN,
    REASONING_PARSER,
    REASONING_PARSER_PLUGIN_SHA256,
    TOOL_CALL_PARSER,
    safe_artifact_path,
    sha256_file,
    sha256_tree,
    validate_export_receipt,
)


APP_NAME = "understudy-nemotron-merge-export"
SOURCE_VOLUME_NAME = "understudy-nemotron-lora-adapters"
BASE_VOLUME_NAME = "understudy-nemotron-model-cache"
OUTPUT_VOLUME_NAME = "understudy-nemotron-long-context-models"
SOURCE_ROOT = Path("/source")
BASE_ROOT = Path("/base")
OUTPUT_ROOT = Path("/models")

app = modal.App(APP_NAME)
source_volume = modal.Volume.from_name(SOURCE_VOLUME_NAME, create_if_missing=False)
base_volume = modal.Volume.from_name(BASE_VOLUME_NAME, create_if_missing=False)
output_volume = modal.Volume.from_name(OUTPUT_VOLUME_NAME, create_if_missing=False)
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "tinker-cookbook==0.5.3",
        "huggingface-hub==1.26.0",
        "transformers==5.5.4",
        "safetensors==0.8.0",
        "torch==2.13.0",
    )
    .env({"HF_HOME": str(BASE_ROOT / "hf"), "PYTHONPATH": "/opt/understudy"})
    .add_local_file(
        "scripts/nemotron_long_context_contract.py",
        "/opt/understudy/nemotron_long_context_contract.py",
    )
)


def build_receipt(
    *,
    source_adapter_id: str,
    source_dir: Path,
    artifact_dir: Path,
) -> dict:
    artifact_sha, files = sha256_tree(artifact_dir, exclude={"export-receipt.json"})
    source_sha, source_files = sha256_tree(source_dir)
    receipt = {
        "schema_version": EXPORT_SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "base_model": BASE_MODEL,
        "base_revision": BASE_REVISION,
        "source_checkpoint": {
            "ref": f"modal-volume://{SOURCE_VOLUME_NAME}/{source_adapter_id}",
            "sha256": source_sha,
            "files": source_files,
        },
        "inspection": {
            "multi_lora_faithful": False,
            "incompatible_nonempty_tensors": [{"module": "in_proj"}],
            "decision_basis": "reviewed PEFT export contains nonempty in_proj tensors",
        },
        "selection": {
            "artifact_kind": "merged-hf",
            "reason": "nonempty in_proj tensors are outside the certified vLLM hotload surface",
            "multi_lora_allowed": False,
            "fail_closed": True,
        },
        "artifact": {"path": str(artifact_dir), "sha256": artifact_sha, "files": files},
        "serving": {
            "runtime": "modal-h200-vllm",
            "dtype": "bfloat16",
            "max_model_len": MAX_MODEL_LEN,
            "reasoning_parser": REASONING_PARSER,
            "reasoning_parser_plugin_sha256": REASONING_PARSER_PLUGIN_SHA256,
            "tool_call_parser": TOOL_CALL_PARSER,
            "proxy_auth": True,
            "truncate_messages": False,
            "max_containers": 1,
            "scaledown_window_seconds": 300,
        },
        "privacy": {"holdout_accessed": False, "dev_labels_accessed": False},
    }
    validate_export_receipt(receipt)
    return receipt


@app.function(
    image=image,
    cpu=8,
    memory=65536,
    timeout=4 * 60 * 60,
    max_containers=1,
    volumes={
        str(SOURCE_ROOT): source_volume,
        str(BASE_ROOT): base_volume,
        str(OUTPUT_ROOT): output_volume,
    },
)
def merge(
    source_adapter_id: str,
    artifact_id: str,
    expected_adapter_sha256: str,
    expected_config_sha256: str,
) -> dict:
    from huggingface_hub import snapshot_download
    from tinker_cookbook import weights

    source_dir = safe_artifact_path(SOURCE_ROOT, source_adapter_id)
    artifact_dir = safe_artifact_path(OUTPUT_ROOT, artifact_id)
    if artifact_dir.exists():
        raise ValueError("immutable output artifact already exists")
    adapter_path = source_dir / "adapter_model.safetensors"
    config_path = source_dir / "adapter_config.json"
    if sha256_file(adapter_path) != expected_adapter_sha256:
        raise ValueError("source adapter hash mismatch")
    if sha256_file(config_path) != expected_config_sha256:
        raise ValueError("source adapter config hash mismatch")

    pinned_base = Path(snapshot_download(
        repo_id=BASE_MODEL,
        revision=BASE_REVISION,
        local_dir=str(BASE_ROOT / BASE_REVISION),
    ))
    weights.build_hf_model(
        base_model=str(pinned_base),
        adapter_path=str(source_dir),
        output_path=str(artifact_dir),
        dtype="bfloat16",
        trust_remote_code=True,
        merge_strategy="shard",
    )
    receipt = build_receipt(
        source_adapter_id=source_adapter_id,
        source_dir=source_dir,
        artifact_dir=artifact_dir,
    )
    (artifact_dir / "export-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    output_volume.commit()
    base_volume.commit()
    return {
        "artifact_id": artifact_id,
        "artifact_sha256": receipt["artifact"]["sha256"],
        "source_sha256": receipt["source_checkpoint"]["sha256"],
        "privacy": receipt["privacy"],
    }


@app.local_entrypoint()
def main(
    source_adapter_id: str,
    artifact_id: str,
    expected_adapter_sha256: str,
    expected_config_sha256: str,
) -> None:
    print(json.dumps(merge.remote(
        source_adapter_id,
        artifact_id,
        expected_adapter_sha256,
        expected_config_sha256,
    ), indent=2, sort_keys=True))
