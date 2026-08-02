#!/usr/bin/env python3
"""Convert the supported subset of a Tinker Nemotron-H PEFT adapter for vLLM."""

import argparse
import json
import os
import re
import shutil
from collections import Counter

from safetensors.torch import load_file, save_file


PREFIX = "base_model.model."
KEY_RE = re.compile(
    r"^base_model\.model\.model\.layers\.(\d+)\.mixer\.(.+)\.lora_([AB])\.weight$"
)


def source_key(layer, module, side):
    return f"{PREFIX}model.layers.{layer}.mixer.{module}.lora_{side}.weight"


def target_key(layer, module, side):
    return f"{PREFIX}model.layers.{layer}.mixer.{module}.lora_{side}.weight"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("output")
    ap.add_argument("--model", required=True)
    args = ap.parse_args()

    with open(os.path.join(args.model, "config.json")) as f:
        config = json.load(f)
    if config.get("architectures") != ["NemotronHForCausalLM"]:
        raise ValueError(f"unexpected architectures: {config.get('architectures')}")
    n_experts = config["n_routed_experts"]
    pattern = config["hybrid_override_pattern"]

    index_path = os.path.join(args.model, "model.safetensors.index.json")
    with open(index_path) as f:
        index = json.load(f)
    base_names = set(index["weight_map"])
    required = [
        "backbone.layers.0.mixer.in_proj.weight",
        "backbone.layers.0.mixer.out_proj.weight",
    ]
    missing = [name for name in required if name not in base_names]
    if missing:
        raise ValueError(f"base model parameter names missing: {missing}")

    source_path = os.path.join(args.source, "adapter_model.safetensors")
    tensors = load_file(source_path, device="cpu")
    out = {}
    mapped_sources = set()
    reasons = {}

    def map_pair(layer, src_module, dst_module):
        a = source_key(layer, src_module, "A")
        b = source_key(layer, src_module, "B")
        if a not in tensors or b not in tensors:
            reasons[src_module] = "missing_pair"
            return
        out[target_key(layer, dst_module, "A")] = tensors[a]
        out[target_key(layer, dst_module, "B")] = tensors[b]
        mapped_sources.update((a, b))

    layers = sorted(
        {int(m.group(1)) for key in tensors if (m := KEY_RE.match(key))}
    )
    for layer in layers:
        # vLLM's loader expects the HF q/k/v names here and applies its
        # packed-module mapping while replacing the QKV layer.
        for module in ("q_proj", "k_proj", "v_proj"):
            map_pair(layer, module, module)

        for module in ("o_proj", "out_proj"):
            map_pair(layer, module, module)

        # The vLLM Mamba implementation exposes in_proj, but the Tinker
        # checkpoint's gate_proj/x_proj are not the same shape/layout as that
        # parameter; those are intentionally dropped below.
        for module in ("gate_proj", "x_proj"):
            for side in ("A", "B"):
                key = source_key(layer, module, side)
                if key in tensors:
                    reasons[key] = "unsupported_mamba_gate_or_x_projection"

        for module in ("up_proj", "down_proj"):
            map_pair(layer, f"shared_experts.{module}", f"shared_experts.{module}")

        for module in ("w1", "w2", "w3"):
            for side in ("A", "B"):
                key = source_key(layer, f"experts.{module}", side)
                if key in tensors:
                    reasons[key] = (
                        "unsupported_fused_moe_layout"
                        if tensors[key].numel()
                        else "empty_tensor"
                    )

    for side in ("A", "B"):
        key = f"{PREFIX}model.lm_head.lora_{side}.weight"
        if key in tensors:
            out[f"{PREFIX}model.lm_head.lora_{side}.weight"] = tensors[key]
            mapped_sources.add(key)

    for key in tensors:
        if key not in mapped_sources and key not in reasons:
            reasons[key] = "unrecognized_source_key"

    os.makedirs(args.output, exist_ok=True)
    for fn in ("adapter_config.json", "checkpoint_complete"):
        shutil.copy2(os.path.join(args.source, fn), os.path.join(args.output, fn))
    save_file(out, os.path.join(args.output, "adapter_model.safetensors"))

    total = sum(t.numel() for t in tensors.values())
    mapped = sum(tensors[k].numel() for k in mapped_sources)
    dropped = total - mapped
    report = {
        "source": os.path.abspath(args.source),
        "output": os.path.abspath(args.output),
        "model": os.path.abspath(args.model),
        "architecture": config["architectures"][0],
        "n_routed_experts": n_experts,
        "hybrid_override_pattern": pattern,
        "source_tensor_count": len(tensors),
        "output_tensor_count": len(out),
        "mapped_source_tensor_count": len(mapped_sources),
        "dropped_source_tensor_count": len(tensors) - len(mapped_sources),
        "source_parameter_count": total,
        "mapped_parameter_count": mapped,
        "dropped_parameter_count": dropped,
        "dropped_parameter_fraction": dropped / total if total else 0.0,
        "mapped_source_keys": sorted(mapped_sources),
        "dropped_by_reason": dict(Counter(reasons.values())),
        "dropped_keys": {k: reasons[k] for k in sorted(reasons)},
        "mapping_notes": [
            "q_proj/k_proj/v_proj are retained; vLLM applies its packed QKV mapping.",
            "shared_experts up_proj/down_proj are retained under their vLLM paths.",
            "o_proj and Mamba out_proj are retained.",
            "Mamba gate_proj/x_proj are dropped because vLLM exposes in_proj with a different fused layout.",
            "experts w1/w2/w3 are dropped because this converter does not force the Tinker stacked layout into vLLM fused-MoE LoRA.",
        ],
    }
    with open(os.path.join(args.output, "conversion_report.json"), "w") as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write("\n")
    print(json.dumps({k: report[k] for k in (
        "source_tensor_count", "output_tensor_count",
        "mapped_source_tensor_count", "dropped_source_tensor_count",
        "source_parameter_count", "mapped_parameter_count",
        "dropped_parameter_count", "dropped_parameter_fraction",
        "dropped_by_reason",
    )}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
