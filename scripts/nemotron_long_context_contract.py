#!/usr/bin/env python3
"""Pure contracts for exporting and serving Tinker Nemotron checkpoints.

This module intentionally uses only the Python standard library.  The export
and Modal entrypoints import provider SDKs only inside explicitly invoked live
operations, which keeps inspection and tests provider-free.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
from pathlib import Path
from typing import Any, Iterable


BASE_MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
BASE_REVISION = "2d59de1cbd51c0adf384eb906b766d1aee0e0517"
MAX_MODEL_LEN = 131_072
REASONING_PARSER = "nano_v3"
TOOL_CALL_PARSER = "qwen3_coder"
REASONING_PARSER_PLUGIN = "/opt/understudy/nano_v3_reasoning_parser.py"
REASONING_PARSER_PLUGIN_SHA256 = "aafb12208054504f619cbdd01837e1532a482ad937ed987bfe9a13fb812ae2b7"
REASONING_PARSER_PLUGIN_URL = (
    f"https://huggingface.co/{BASE_MODEL}/resolve/{BASE_REVISION}/nano_v3_reasoning_parser.py"
)
EXPORT_SCHEMA = "understudy.nemotron_long_context_export.v1"
PARITY_SCHEMA = "understudy.nemotron_long_context_parity.v1"

# A Tinker export may use arbitrary prefixes.  Compatibility is decided from
# the terminal module name rather than accepting a broad `all-linear` claim.
VLLM_SAFE_MODULES = frozenset(
    {"q_proj", "k_proj", "v_proj", "o_proj", "out_proj", "up_proj", "down_proj", "lm_head"}
)
LORA_KEY = re.compile(r"(?:^|\.)(?P<module>[A-Za-z0-9_]+)\.lora_(?:A|B)(?:\.default)?\.weight$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path, *, exclude: Iterable[str] = ()) -> tuple[str, list[dict[str, Any]]]:
    excluded = set(exclude)
    files: list[dict[str, Any]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        if relative in excluded:
            continue
        files.append({"path": relative, "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    digest = hashlib.sha256()
    for item in files:
        digest.update(f"{item['path']}\0{item['bytes']}\0{item['sha256']}\n".encode())
    return digest.hexdigest(), files


def _safetensors_header(path: Path) -> dict[str, Any]:
    with path.open("rb") as stream:
        raw_length = stream.read(8)
        if len(raw_length) != 8:
            raise ValueError(f"invalid safetensors header: {path}")
        header_length = struct.unpack("<Q", raw_length)[0]
        if header_length <= 0 or header_length > 128 * 1024 * 1024:
            raise ValueError(f"unsafe safetensors header length in {path}")
        raw_header = stream.read(header_length)
    try:
        header = json.loads(raw_header)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid safetensors JSON header: {path}") from error
    if not isinstance(header, dict):
        raise ValueError(f"invalid safetensors metadata: {path}")
    return header


def inspect_peft_adapter(adapter_dir: Path) -> dict[str, Any]:
    config_path = adapter_dir / "adapter_config.json"
    if not config_path.is_file():
        raise ValueError("adapter_config.json is required")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    declared_base = config.get("base_model_name_or_path")
    if declared_base != BASE_MODEL:
        raise ValueError(f"adapter base model mismatch: {declared_base!r}")

    tensor_files = sorted(adapter_dir.glob("adapter_model*.safetensors"))
    if not tensor_files:
        raise ValueError("at least one adapter_model*.safetensors file is required")
    tensors: list[dict[str, Any]] = []
    incompatible: list[dict[str, Any]] = []
    for tensor_file in tensor_files:
        for key, metadata in sorted(_safetensors_header(tensor_file).items()):
            if key == "__metadata__":
                continue
            if not isinstance(metadata, dict) or not isinstance(metadata.get("shape"), list):
                raise ValueError(f"invalid tensor metadata for {key}")
            shape = metadata["shape"]
            elements = 1
            for dimension in shape:
                if not isinstance(dimension, int) or dimension < 0:
                    raise ValueError(f"invalid tensor shape for {key}")
                elements *= dimension
            match = LORA_KEY.search(key)
            module = match.group("module") if match else None
            compatible = bool(module in VLLM_SAFE_MODULES)
            row = {
                "key": key,
                "file": tensor_file.name,
                "shape": shape,
                "elements": elements,
                "module": module,
                "vllm_compatible": compatible,
            }
            tensors.append(row)
            if elements > 0 and not compatible:
                incompatible.append(row)

    if not tensors:
        raise ValueError("adapter has no tensors")
    declared_targets = config.get("target_modules")
    if not isinstance(declared_targets, list) or not all(isinstance(item, str) for item in declared_targets):
        raise ValueError("adapter target_modules must be an explicit string array")
    unsupported_declared = sorted(set(declared_targets) - VLLM_SAFE_MODULES)
    return {
        "adapter_config_sha256": sha256_file(config_path),
        "tensor_files": [path.name for path in tensor_files],
        "tensor_count": len(tensors),
        "tensor_elements": sum(item["elements"] for item in tensors),
        "declared_target_modules": sorted(set(declared_targets)),
        "unsupported_declared_target_modules": unsupported_declared,
        "incompatible_nonempty_tensors": incompatible,
        "multi_lora_faithful": not incompatible and not unsupported_declared,
    }


def choose_artifact_kind(inspection: dict[str, Any]) -> tuple[str, str]:
    if inspection["incompatible_nonempty_tensors"]:
        return "merged-hf", "nonempty adapter tensors are outside the faithful vLLM LoRA surface"
    if inspection["unsupported_declared_target_modules"]:
        return "merged-hf", "adapter declares target modules outside the faithful vLLM LoRA surface"
    if not inspection["multi_lora_faithful"]:
        raise ValueError("adapter compatibility is unknown; refusing a serving artifact")
    return "peft-lora", "all declared targets and nonempty tensors are vLLM-compatible"


def validate_messages(messages: Any) -> list[dict[str, Any]]:
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages must be a nonempty array")
    normalized: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            raise ValueError(f"message {index} is malformed")
        # Copy every field.  Serving parity depends on tool ids, content blocks,
        # and provider extensions surviving unchanged.
        normalized.append(json.loads(json.dumps(message, sort_keys=True)))
    return normalized


def messages_sha256(messages: Any) -> str:
    normalized = validate_messages(messages)
    return hashlib.sha256(
        json.dumps(normalized, separators=(",", ":"), sort_keys=True).encode()
    ).hexdigest()


def validate_export_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    required = {
        "schema_version", "created_at", "base_model", "base_revision", "source_checkpoint",
        "inspection", "selection", "artifact", "serving", "privacy",
    }
    missing = sorted(required - receipt.keys())
    if missing:
        raise ValueError(f"export receipt is missing fields: {missing}")
    if receipt["schema_version"] != EXPORT_SCHEMA:
        raise ValueError("unexpected export receipt schema")
    if receipt["base_model"] != BASE_MODEL or receipt["base_revision"] != BASE_REVISION:
        raise ValueError("export receipt does not pin the approved BF16 base revision")
    serving = receipt["serving"]
    if serving.get("max_model_len", 0) < MAX_MODEL_LEN or serving.get("truncate_messages") is not False:
        raise ValueError("export receipt does not preserve long-context messages")
    if serving.get("reasoning_parser") != REASONING_PARSER or serving.get("tool_call_parser") != TOOL_CALL_PARSER:
        raise ValueError("export receipt parser contract mismatch")
    if serving.get("reasoning_parser_plugin_sha256") != REASONING_PARSER_PLUGIN_SHA256:
        raise ValueError("export receipt reasoning parser plugin mismatch")
    if receipt["privacy"] != {"holdout_accessed": False, "dev_labels_accessed": False}:
        raise ValueError("export receipt privacy boundary mismatch")
    kind = receipt["selection"].get("artifact_kind")
    incompatible = receipt["inspection"].get("incompatible_nonempty_tensors", [])
    if incompatible and kind != "merged-hf":
        raise ValueError("incompatible nonempty tensors must select merged-hf")
    if kind not in {"merged-hf", "peft-lora"}:
        raise ValueError("invalid artifact kind")
    artifact_hash = receipt["artifact"].get("sha256", "")
    if not re.fullmatch(r"[a-f0-9]{64}", artifact_hash):
        raise ValueError("invalid artifact hash")
    return receipt


def safe_artifact_path(volume_root: Path, artifact_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", artifact_id):
        raise ValueError("artifact id must be a safe immutable slug")
    root = volume_root.resolve()
    candidate = (root / artifact_id).resolve()
    if candidate.parent != root:
        raise ValueError("artifact path escapes model volume")
    return candidate


def require_proxy_auth_environment(environment: dict[str, str] | None = None) -> tuple[str, str]:
    env = os.environ if environment is None else environment
    key = env.get("MODAL_PROXY_KEY", "").strip()
    secret = env.get("MODAL_PROXY_SECRET", "").strip()
    if not key or not secret:
        raise ValueError("Modal proxy authentication requires MODAL_PROXY_KEY and MODAL_PROXY_SECRET")
    return key, secret
