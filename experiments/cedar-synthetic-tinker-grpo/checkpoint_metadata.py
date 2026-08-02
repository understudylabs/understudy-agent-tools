"""Prompt/renderer identity metadata for Cedar experiment checkpoints."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rollout import LORA_RANK, MODEL_NAME, PROMPT_VARIANT, RENDERER_NAME

METADATA_PATH = Path(__file__).resolve().parent / "artifacts" / "checkpoint-metadata.json"
PROMPT_IDENTITY = "1a50541f7c25da20bbcd407c3f736560797107fb84aaec7725473153488a1a11"


def identity() -> dict[str, str]:
    return {
        "model": MODEL_NAME,
        "lora_rank": LORA_RANK,
        "prompt_variant": PROMPT_VARIANT,
        "prompt_identity": PROMPT_IDENTITY,
        "renderer": RENDERER_NAME,
    }


def register(paths: list[str], phase: str) -> None:
    data: dict[str, Any] = {"schema_version": "cedar.checkpoint_identity.v1", "checkpoints": {}}
    if METADATA_PATH.exists():
        data = json.loads(METADATA_PATH.read_text())
    for path in paths:
        data["checkpoints"][path] = {**identity(), "phase": phase}
    METADATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    METADATA_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def require(path: str) -> dict[str, Any]:
    if not METADATA_PATH.exists():
        raise RuntimeError(f"checkpoint metadata is missing: {METADATA_PATH}")
    data = json.loads(METADATA_PATH.read_text())
    record = data.get("checkpoints", {}).get(path)
    if not isinstance(record, dict):
        raise RuntimeError(f"checkpoint has no identity metadata: {path}")
    expected = identity()
    mismatches = {
        key: (record.get(key), value)
        for key, value in expected.items()
        if record.get(key) != value
    }
    if mismatches:
        raise RuntimeError(f"checkpoint identity mismatch for {path}: {mismatches}")
    return record
