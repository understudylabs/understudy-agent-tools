#!/usr/bin/env python3
"""Convert Tinker Nemotron-H LoRA archives to vLLM/PEFT module names.

The Tinker export stores Nemotron-H MoE factors as stacked experts:
``experts.w1`` (up projection) and ``experts.w2`` (down projection).  vLLM's
Nemotron-H loader discovers the PEFT-style per-expert ``up_proj`` and
``down_proj`` names, so this converter expands the stacked factors.

The Tinker Mamba ``gate_proj`` and ``x_proj`` factors are from a different
projection layout than the HF/vLLM Nemotron-H ``in_proj`` and are intentionally
dropped rather than silently applying them to the wrong slice.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import torch
from safetensors.torch import load_file, save_file


LORA_KEY = re.compile(
    r"^(?P<prefix>base_model\.model\.)?"
    r"(?P<module>(?:model\.layers\.(?P<layer>\d+)\.mixer\."
    r"(?P<target>experts\.w[123]|gate_proj|x_proj|"
    r"shared_experts\.(?:up_proj|down_proj)|"
    r"(?:q_proj|k_proj|v_proj|o_proj|out_proj))|model\.lm_head))"
    r"\.lora_(?P<side>[AB])\.weight$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--config", type=Path)
    return parser.parse_args()


def _set_count(counts: Counter[str], key: str, tensor: torch.Tensor) -> None:
    counts[key] += tensor.numel()


def convert(source: Path, destination: Path, config_path: Path | None) -> dict[str, Any]:
    tensors = load_file(str(source), device="cpu")
    converted: dict[str, torch.Tensor] = {}
    counts: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    source_total = sum(t.numel() for t in tensors.values())
    mapped_source = 0

    grouped: dict[tuple[int, str], dict[str, torch.Tensor]] = {}
    passthrough: list[tuple[str, torch.Tensor, re.Match[str]]] = []
    for key, tensor in tensors.items():
        match = LORA_KEY.match(key)
        if match is None:
            raise ValueError(f"Unsupported or unexpected tensor key: {key}")
        target = match.group("target")
        layer_text = match.group("layer")
        layer = int(layer_text) if layer_text is not None else -1
        side = match.group("side")
        if target in {"gate_proj", "x_proj"}:
            dropped[target] += tensor.numel()
        elif target is not None and target.startswith("experts."):
            grouped.setdefault((layer, target), {})[side] = tensor
        else:
            passthrough.append((key, tensor, match))

    # Keep attention, shared-expert, output, and other direct PEFT modules.
    for source_key, tensor, match in passthrough:
        module = match.group("module")
        destination_key = f"{module}.lora_{match.group('side')}.weight"
        converted[destination_key] = tensor
        _set_count(counts, match.group("target") or "lm_head", tensor)
        mapped_source += tensor.numel()

    # Expand stacked Tinker expert factors into the names expected by PEFT/vLLM.
    for (layer, target), parts in grouped.items():
        if target == "experts.w3":
            dropped[target] += sum(t.numel() for t in parts.values())
            continue
        if set(parts) != {"A", "B"}:
            raise ValueError(f"Incomplete expert factor pair for layer {layer}: {target}")
        a, b = parts["A"], parts["B"]
        if a.ndim != 3 or b.ndim != 3:
            raise ValueError(f"Expected stacked 3-D expert factors for {layer}/{target}")
        mapped_source += a.numel() + b.numel()
        experts = max(a.shape[0], b.shape[0])
        for expert in range(experts):
            # Tinker's shared-outer factor has expert dimension one; reuse it.
            a_expert = a[0 if a.shape[0] == 1 else expert].clone()
            b_expert = b[0 if b.shape[0] == 1 else expert].clone()
            projection = "up_proj" if target == "experts.w1" else "down_proj"
            module = f"model.layers.{layer}.mixer.experts.{expert}.{projection}"
            converted[f"{module}.lora_A.weight"] = a_expert
            converted[f"{module}.lora_B.weight"] = b_expert
            counts[f"experts.{projection}"] += a_expert.numel() + b_expert.numel()

    destination.mkdir(parents=True, exist_ok=True)
    save_file(converted, str(destination / "adapter_model.safetensors"))

    config = json.loads((config_path or source.parent / "adapter_config.json").read_text())
    config["target_modules"] = [
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "up_proj",
        "down_proj",
        "lm_head",
    ]
    (destination / "adapter_config.json").write_text(
        json.dumps(config, indent=2, sort_keys=True) + "\n"
    )

    mapped = mapped_source
    dropped_total = sum(dropped.values())
    report = {
        "source": str(source),
        "destination": str(destination),
        "sourceTensorParameters": source_total,
        "mappedTensorParameters": mapped,
        "convertedTensorParameters": sum(t.numel() for t in converted.values()),
        "droppedTensorParameters": dropped_total,
        "mappedFraction": mapped / source_total if source_total else 0,
        "droppedFraction": dropped_total / source_total if source_total else 0,
        "mappedByModule": dict(sorted(counts.items())),
        "droppedByModule": dict(sorted(dropped.items())),
        "notes": [
            "experts.w1 -> per-expert experts.<id>.up_proj",
            "experts.w2 -> per-expert experts.<id>.down_proj",
            "experts.w3 is empty/non-gated and dropped",
            "Mamba gate_proj/x_proj are incompatible with vLLM in_proj packing and dropped",
        ],
    }
    (destination / "conversion-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n"
    )
    return report


if __name__ == "__main__":
    args = parse_args()
    result = convert(args.source, args.destination, args.config)
    print(json.dumps(result, indent=2, sort_keys=True))
