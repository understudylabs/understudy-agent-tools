#!/usr/bin/env python3
"""DPO (Direct Preference Optimization) on Tinker from a validated preference file.

Input is the normalized JSONL emitted by `scripts/dpo-pairs-validate.mjs` — one
object per line with `prompt_conversation`, `chosen`, `rejected`, and the fixture
`task_id` it came from. This script deliberately refuses raw pair files: the
validator is what proves the pairs are synthetic, train-split-only, and hash-
matched to their manifest, so training must not be reachable without it.

Tinker is the only clean train+serve lane for Nemotron (Fireworks reports
`supportsLora=false` for it), so both training and later scoring stay here: the
run's final checkpoint is served back through `scripts/tinker-openai-shim.py`.

  TINKER_API_KEY=... python scripts/tinker-dpo-train.py \
      --pairs outputs/dpo/pairs.normalized.jsonl \
      --base-model nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
      --renderer nemotron3 --lora-rank 32 --beta 0.1 --epochs 2 \
      --out outputs/dpo/train-receipt.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import chz
import datasets

# pyqwest (the Rust HTTP backend tinker prefers) carries its own root store and
# rejects otherwise-valid certificates on some Linux hosts. Opt in to httpx's
# system trust store when that happens; the wire protocol is identical.
if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
    import httpx
    import tinker._base_client as _tinker_base_client

    _tinker_base_client._default_pyqwest_transport = lambda: httpx.AsyncHTTPTransport(retries=2)

from tinker_cookbook.preference import train_dpo  # noqa: E402
from tinker_cookbook.preference.dpo_datasets import DPODatasetBuilderFromComparisons  # noqa: E402
from tinker_cookbook.preference.preference_datasets import ComparisonDatasetBuilder  # noqa: E402
from tinker_cookbook.preference.types import Comparison, LabeledComparison  # noqa: E402
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--pairs", required=True, help="normalized JSONL from dpo-pairs-validate.mjs")
parser.add_argument("--base-model", required=True)
parser.add_argument("--renderer", required=True)
parser.add_argument("--lora-rank", type=int, default=32)
parser.add_argument("--beta", type=float, default=0.1)
parser.add_argument("--learning-rate", type=float, default=1e-5)
parser.add_argument("--epochs", type=int, default=2)
parser.add_argument("--batch-size", type=int, default=8)
parser.add_argument("--max-length", type=int, default=8192)
parser.add_argument("--max-steps", type=int, default=None)
parser.add_argument("--log-path", default=None)
parser.add_argument("--out", required=True, help="where to write the run receipt")
args = parser.parse_args()

pairs_path = Path(args.pairs)
raw = pairs_path.read_bytes()
pairs_sha256 = hashlib.sha256(raw).hexdigest()
rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
if not rows:
    raise SystemExit(f"{pairs_path} has no pairs")

for index, row in enumerate(rows):
    if row.get("split") != "train":
        raise SystemExit(f"line {index + 1}: split={row.get('split')!r}; only train-split pairs are trainable")
    for field in ("prompt_conversation", "chosen", "rejected"):
        if not isinstance(row.get(field), list) or not row[field]:
            raise SystemExit(f"line {index + 1}: missing {field}; run dpo-pairs-validate.mjs first")

band_counts: dict[str, int] = {}
for row in rows:
    band_counts[row.get("band", "unknown")] = band_counts.get(row.get("band", "unknown"), 0) + 1


@chz.chz
class NearHitComparisonBuilder(ComparisonDatasetBuilder):
    """Serves the validated near-hit pairs as labeled comparisons (chosen == A)."""

    pairs_jsonl: str = ""

    def get_train_and_test_datasets(self) -> tuple[datasets.Dataset, datasets.Dataset | None]:
        payload = [
            {
                "prompt": json.dumps(row["prompt_conversation"]),
                "chosen": json.dumps(row["chosen"]),
                "rejected": json.dumps(row["rejected"]),
            }
            for row in rows
        ]
        return datasets.Dataset.from_list(payload), None

    def example_to_labeled_comparison(self, example: dict) -> LabeledComparison | None:
        return LabeledComparison(
            comparison=Comparison(
                prompt_conversation=json.loads(example["prompt"]),
                completion_A=json.loads(example["chosen"]),
                completion_B=json.loads(example["rejected"]),
            ),
            label="A",
        )


log_path = args.log_path or f"/tmp/understudy-dpo/{int(time.time())}"
config = train_dpo.Config(
    log_path=log_path,
    model_name=args.base_model,
    recipe_name="understudy_synthetic_offline_near_hit_dpo",
    renderer_name=args.renderer,
    dataset_builder=DPODatasetBuilderFromComparisons(
        common_config=ChatDatasetBuilderCommonConfig(
            model_name_for_tokenizer=args.base_model,
            renderer_name=args.renderer,
            max_length=args.max_length,
            batch_size=args.batch_size,
        ),
        comparison_builder=NearHitComparisonBuilder(pairs_jsonl=str(pairs_path)),
    ),
    learning_rate=args.learning_rate,
    dpo_beta=args.beta,
    lora_rank=args.lora_rank,
    num_epochs=args.epochs,
    max_steps=args.max_steps,
    evaluator_builders=[],
    save_every=0,
    eval_every=0,
    infrequent_eval_every=0,
)

started = time.time()
train_dpo.main(config)
elapsed = round(time.time() - started, 1)


def final_checkpoint(directory: str) -> str | None:
    """Last `sampler_path`/`path` recorded in the run's checkpoints log."""
    log = Path(directory) / "checkpoints.jsonl"
    if not log.exists():
        return None
    entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    if not entries:
        return None
    last = entries[-1]
    return last.get("sampler_path") or last.get("path")


receipt = {
    "schema_version": "understudy.tinker_dpo.receipt.v1",
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "backend": "tinker",
    "base_model": args.base_model,
    "renderer": args.renderer,
    "pairs_path": str(pairs_path),
    "pairs_sha256": pairs_sha256,
    "pairs": len(rows),
    "pairs_by_band": band_counts,
    "hyperparameters": {
        "lora_rank": args.lora_rank,
        "dpo_beta": args.beta,
        "learning_rate": args.learning_rate,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "max_length": args.max_length,
        "max_steps": args.max_steps,
    },
    "log_path": log_path,
    "checkpoint": final_checkpoint(log_path),
    "wall_clock_s": elapsed,
}
out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
