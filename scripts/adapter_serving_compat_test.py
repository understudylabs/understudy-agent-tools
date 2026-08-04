#!/usr/bin/env python3
"""Provider-free regression tests for adapter-serving-compat.py."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("adapter-serving-compat.py")
SPEC = importlib.util.spec_from_file_location("adapter_serving_compat", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)
MODEL = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"


def config(root: Path, targets: object) -> Path:
    path = root / "adapter_config.json"
    path.write_text(json.dumps({"target_modules": targets}) + "\n", encoding="utf-8")
    return path


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        all_linear = MODULE.assess(config(root, "all-linear"), "vllm-nemotron-h", MODEL)
        assert all_linear["compatibility"] == "incompatible"
        assert all_linear["faithful"] is False
        supported = MODULE.assess(
            config(root, ["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj"]),
            "vllm-nemotron-h", MODEL,
        )
        assert supported["compatibility"] == "faithful"
        unsupported = MODULE.assess(
            config(root, ["q_proj", "gate_proj", "experts.w1"]), "vllm-nemotron-h", MODEL
        )
        assert unsupported["unsupported_target_modules"] == ["experts.w1", "gate_proj"]
        native = MODULE.assess(config(root, "all-linear"), "tinker-sampling", MODEL)
        assert native["compatibility"] == "faithful"
        unknown = MODULE.assess(config(root, ["q_proj"]), "vllm-nemotron-h", "some/other-model")
        assert unknown["compatibility"] == "unknown"
        assert unknown["faithful"] is False
    print("ALL ADAPTER SERVING COMPAT TESTS PASSED")


if __name__ == "__main__":
    main()
