#!/usr/bin/env python3
"""Build a QAT-aware mixed-bit Gemma 4 MoE candidate for local certification."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

LAYER_PATTERN = re.compile(r"(?:^|\.)layers\.(\d+)(?:\.|$)")


def parse_layers(value: str) -> set[int]:
    layers: set[int] = set()
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" in token:
            start_text, end_text = token.split("-", 1)
            start, end = int(start_text), int(end_text)
            if start > end:
                raise argparse.ArgumentTypeError(f"invalid layer range: {token}")
            layers.update(range(start, end + 1))
        else:
            layers.add(int(token))
    if not layers or min(layers) < 0:
        raise argparse.ArgumentTypeError("protected layers must be non-negative")
    return layers


def build_predicate(
    protected_layers: set[int],
    *,
    group_size: int,
    low_bits: int,
    high_bits: int,
    router_bits: int,
    skip_multimodal_module,
):
    def predicate(path, module):
        if skip_multimodal_module(path) or not hasattr(module, "to_quantized"):
            return False
        weight = getattr(module, "weight", None)
        if weight is None or len(weight.shape) < 2 or weight.shape[1] % group_size != 0:
            return False
        if "router.proj" in path:
            return {"group_size": group_size, "bits": router_bits}
        if "embed_tokens" in path or "lm_head" in path:
            return {"group_size": group_size, "bits": high_bits}
        match = LAYER_PATTERN.search(path)
        bits = high_bits if match and int(match.group(1)) in protected_layers else low_bits
        return {"group_size": group_size, "bits": bits}

    return predicate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--protected-layers", type=parse_layers, default=parse_layers("15-29"))
    parser.add_argument("--group-size", type=int, default=32)
    parser.add_argument("--low-bits", type=int, default=4)
    parser.add_argument("--high-bits", type=int, default=6)
    parser.add_argument("--router-bits", type=int, default=8)
    args = parser.parse_args()

    if not args.source.is_dir():
        parser.error(f"source is not a directory: {args.source}")
    if args.output.exists():
        parser.error(f"output already exists: {args.output}")
    if args.group_size != 32:
        parser.error("Gemma QAT candidates require group size 32")
    if not 2 <= args.low_bits < args.high_bits <= args.router_bits <= 8:
        parser.error("expected 2 <= low bits < high bits <= router bits <= 8")

    from mlx_vlm.convert import convert
    from mlx_vlm.utils import skip_multimodal_module

    protected_layers = sorted(args.protected_layers)
    convert(
        str(args.source),
        str(args.output),
        quantize=True,
        q_group_size=args.group_size,
        q_bits=args.low_bits,
        dtype="bfloat16",
        quant_predicate=build_predicate(
            set(protected_layers),
            group_size=args.group_size,
            low_bits=args.low_bits,
            high_bits=args.high_bits,
            router_bits=args.router_bits,
            skip_multimodal_module=skip_multimodal_module,
        ),
    )
    manifest = {
        "format": "understudy.local_mixed_quantization.v1",
        "source": str(args.source.resolve()),
        "output": str(args.output.resolve()),
        "group_size": args.group_size,
        "low_bits": args.low_bits,
        "high_bits": args.high_bits,
        "router_bits": args.router_bits,
        "protected_layers": protected_layers,
        "promotion_status": "candidate_requires_strict_tool_certification",
    }
    (args.output / "understudy.quantization.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
