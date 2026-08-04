#!/usr/bin/env python3
"""Fail-closed LoRA training/serving compatibility preflight."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

NEMOTRON_H_MARKERS = ("NVIDIA-Nemotron-3-Nano", "Nemotron-3-Nano")
VLLM_NEMOTRON_H_TARGETS = frozenset({
    "q_proj", "k_proj", "v_proj", "o_proj", "out_proj",
    "up_proj", "down_proj", "lm_head",
})


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_targets(value: object) -> tuple[list[str], str | None]:
    if isinstance(value, str):
        return [value], value if value in {"all-linear", "all_linear"} else None
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        targets = sorted(set(value))
        wildcard = next((item for item in targets if item in {"all-linear", "all_linear"}), None)
        return targets, wildcard
    return [], "missing_or_invalid"


def assess(config_path: Path, runtime: str, base_model: str) -> dict:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    targets, wildcard = _normalize_targets(config.get("target_modules"))
    receipt = {
        "schema_version": 1,
        "adapter_config": str(config_path),
        "adapter_config_sha256": _sha256(config_path),
        "runtime": runtime,
        "base_model": base_model,
        "training_target_modules": targets,
        "compatibility": "unknown",
        "faithful": False,
        "unsupported_target_modules": [],
        "reason": "unsupported runtime or model; no faithful compatibility claim is available",
    }
    if runtime == "tinker-sampling":
        receipt.update(
            compatibility="faithful",
            faithful=True,
            reason="Tinker sampling serves the checkpoint through its native trained-weight path",
        )
        return receipt

    is_nemotron_h = any(marker in base_model for marker in NEMOTRON_H_MARKERS)
    if runtime != "vllm-nemotron-h" or not is_nemotron_h:
        return receipt
    if wildcard:
        receipt.update(
            compatibility="incompatible",
            reason=(
                "wildcard all-linear training includes Nemotron-H Mamba and routed-MoE "
                "targets that vLLM cannot faithfully represent"
            ),
            unsupported_target_modules=[wildcard],
        )
        return receipt
    if not targets:
        receipt.update(
            compatibility="incompatible",
            reason="adapter target_modules is missing or invalid; compatibility must fail closed",
            unsupported_target_modules=["missing_or_invalid"],
        )
        return receipt
    unsupported = sorted(set(targets) - VLLM_NEMOTRON_H_TARGETS)
    if unsupported:
        receipt.update(
            compatibility="incompatible",
            reason="one or more trained targets are outside the faithful vLLM Nemotron-H surface",
            unsupported_target_modules=unsupported,
        )
        return receipt
    receipt.update(
        compatibility="faithful",
        faithful=True,
        reason="all declared training targets are within the supported vLLM Nemotron-H surface",
    )
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter-config", type=Path, required=True)
    parser.add_argument("--runtime", choices=("tinker-sampling", "vllm-nemotron-h"), required=True)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    result = assess(args.adapter_config, args.runtime, args.base_model)
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0 if result["faithful"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
