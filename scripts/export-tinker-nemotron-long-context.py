#!/usr/bin/env python3
"""Export a Tinker Nemotron checkpoint for faithful 131K vLLM serving.

`inspect` is provider-free. `export` is an explicit network/filesystem action:
it downloads an existing checkpoint but never trains, samples, or deploys.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from nemotron_long_context_contract import (
    BASE_MODEL,
    BASE_REVISION,
    CHAT_TEMPLATE_KWARGS,
    EXPORT_SCHEMA,
    MAX_MODEL_LEN,
    REASONING_PARSER,
    REASONING_PARSER_PLUGIN_SHA256,
    RENDERER,
    TOOL_CALL_PARSER,
    choose_artifact_kind,
    inspect_peft_adapter,
    sha256_tree,
    validate_export_receipt,
)


def _provider_weights():
    if importlib.util.find_spec("tinker_cookbook") is None:
        raise RuntimeError("tinker-cookbook is required only for the explicit export operation")
    from tinker_cookbook import weights

    return weights


def _pinned_base_snapshot(output_dir: Path) -> Path:
    if importlib.util.find_spec("huggingface_hub") is None:
        raise RuntimeError("huggingface-hub is required only for the explicit export operation")
    from huggingface_hub import snapshot_download

    path = snapshot_download(
        repo_id=BASE_MODEL,
        revision=BASE_REVISION,
        local_dir=str(output_dir),
    )
    return Path(path)


def _normalize_peft_base(peft_dir: Path, pinned_base: Path) -> None:
    config_path = peft_dir / "adapter_config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    declared = Path(str(config.get("base_model_name_or_path", ""))).resolve()
    if declared != pinned_base.resolve():
        raise ValueError("PEFT export did not use the pinned BF16 base snapshot")
    # Runtime uses the public model id plus an explicit revision.  Keep the
    # portable PEFT field standard and bind the revision in the signed receipt.
    config["base_model_name_or_path"] = BASE_MODEL
    config_path.write_text(json.dumps(config, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_receipt(
    *, source: str, peft_dir: Path, artifact_dir: Path, artifact_kind: str,
    inspection: dict, reason: str, output: Path,
) -> dict:
    artifact_sha, files = sha256_tree(artifact_dir, exclude={output.name})
    receipt = {
        "schema_version": EXPORT_SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "base_model": BASE_MODEL,
        "base_revision": BASE_REVISION,
        "source_checkpoint": {"ref": source, "downloaded_peft_sha256": sha256_tree(peft_dir)[0]},
        "inspection": inspection,
        "selection": {
            "artifact_kind": artifact_kind,
            "reason": reason,
            "multi_lora_allowed": artifact_kind == "peft-lora",
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
            "renderer": RENDERER,
            "chat_template_kwargs": CHAT_TEMPLATE_KWARGS,
            "proxy_auth": True,
            "truncate_messages": False,
            "max_containers": 1,
            "scaledown_window_seconds": 300,
        },
        "privacy": {"holdout_accessed": False, "dev_labels_accessed": False},
    }
    validate_export_receipt(receipt)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def inspect_command(args: argparse.Namespace) -> int:
    inspection = inspect_peft_adapter(args.peft_dir)
    kind, reason = choose_artifact_kind(inspection)
    result = {"inspection": inspection, "selected_artifact_kind": kind, "reason": reason}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def export_command(args: argparse.Namespace) -> int:
    if not args.confirm_export:
        raise ValueError("export requires --confirm-export; no provider or model download was started")
    weights = _provider_weights()
    workspace = args.output_dir.resolve()
    if workspace.exists() and any(workspace.iterdir()):
        raise ValueError("output directory must be absent or empty")
    workspace.mkdir(parents=True, exist_ok=True)
    downloaded = Path(weights.download(tinker_path=args.tinker_path, output_dir=str(workspace / "download")))
    pinned_base = _pinned_base_snapshot(workspace / "base" / BASE_REVISION)
    peft_dir = workspace / "peft"
    weights.build_lora_adapter(base_model=str(pinned_base), adapter_path=downloaded, output_path=str(peft_dir))
    _normalize_peft_base(peft_dir, pinned_base)
    inspection = inspect_peft_adapter(peft_dir)
    kind, reason = choose_artifact_kind(inspection)
    if kind == "peft-lora":
        artifact_dir = workspace / "artifact-peft"
        shutil.copytree(peft_dir, artifact_dir)
    else:
        artifact_dir = workspace / "artifact-merged-hf"
        # Never feed a lossy converted PEFT directory into the merge.  Merge the
        # original downloaded Tinker checkpoint against the pinned BF16 base.
        weights.build_hf_model(base_model=str(pinned_base), adapter_path=downloaded, output_path=str(artifact_dir))
    receipt = _write_receipt(
        source=args.tinker_path,
        peft_dir=peft_dir,
        artifact_dir=artifact_dir,
        artifact_kind=kind,
        inspection=inspection,
        reason=reason,
        output=artifact_dir / "export-receipt.json",
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subcommands = root.add_subparsers(dest="command", required=True)
    inspect = subcommands.add_parser("inspect")
    inspect.add_argument("--peft-dir", type=Path, required=True)
    inspect.set_defaults(run=inspect_command)
    export = subcommands.add_parser("export")
    export.add_argument("--tinker-path", required=True)
    export.add_argument("--output-dir", type=Path, required=True)
    export.add_argument("--confirm-export", action="store_true")
    export.set_defaults(run=export_command)
    return root


if __name__ == "__main__":
    try:
        parsed = parser().parse_args()
        raise SystemExit(parsed.run(parsed))
    except (RuntimeError, ValueError) as error:
        print(json.dumps({"error": str(error), "failed_closed": True}), file=sys.stderr)
        raise SystemExit(2)
