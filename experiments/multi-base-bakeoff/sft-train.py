#!/usr/bin/env python3
"""SFT rung of the multi-base bake-off, on Tinker.

Behaviour cloning of the fixture's scripted oracle trajectories, exported by
`export-oracle-sft.mjs` in the serving contract's own conversation shape. Loss
is taken on assistant turns only, so the model is trained to emit exactly the
one-JSON-call-per-turn protocol it is scored under.

Every base runs this identical script on the identical trajectory file — only
`--base-model` and `--renderer` change — which is what makes the SFT rung of
the bake-off a controlled comparison.

  TINKER_API_KEY=... python experiments/multi-base-bakeoff/sft-train.py \
      --trajectories outputs/bakeoff/sft/oracle-train.jsonl \
      --base-model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking \
      --out outputs/bakeoff/sft/qwen3.5-9b-receipt.json
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import time
from pathlib import Path

if os.environ.get("TINKER_DISABLE_PYQWEST") == "1":
    import httpx
    import tinker._base_client as _tinker_base_client

    _tinker_base_client._default_pyqwest_transport = lambda: httpx.AsyncHTTPTransport(retries=2)

from tinker_cookbook.renderers import TrainOnWhat  # noqa: E402
from tinker_cookbook.supervised import train as train_sft  # noqa: E402
from tinker_cookbook.supervised.data import FromConversationFileBuilder  # noqa: E402
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--trajectories", required=True, help="JSONL from export-oracle-sft.mjs")
parser.add_argument("--manifest", default=None, help="its manifest; defaults to <trajectories>.manifest.json")
parser.add_argument("--base-model", required=True)
parser.add_argument("--renderer", required=True)
parser.add_argument("--lora-rank", type=int, default=32)
parser.add_argument("--learning-rate", type=float, default=1e-4)
parser.add_argument("--epochs", type=int, default=3)
parser.add_argument("--batch-size", type=int, default=8)
parser.add_argument("--max-length", type=int, default=16384)
parser.add_argument("--max-steps", type=int, default=None)
parser.add_argument("--log-path", default=None)
parser.add_argument("--out", required=True)
args = parser.parse_args()

trajectories = Path(args.trajectories)
raw = trajectories.read_bytes()
rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
if not rows:
    raise SystemExit(f"{trajectories} has no trajectories")

manifest_path = Path(args.manifest) if args.manifest else Path(str(trajectories).replace(".jsonl", "") + ".manifest.json")
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
data_sha256 = hashlib.sha256(raw).hexdigest()
if manifest.get("sha256") and manifest["sha256"] != data_sha256:
    raise SystemExit("trajectory file does not match its manifest hash")

# Dev picks the configuration and the holdout is sealed: neither may be trained on.
for index, row in enumerate(rows):
    if row.get("split") != "train":
        raise SystemExit(f"line {index + 1}: split={row.get('split')!r}; only train-split trajectories are trainable")

log_path = args.log_path or f"/tmp/understudy-bakeoff-sft/{args.base_model.replace('/', '_')}-{int(time.time())}"
config = train_sft.Config(
    log_path=log_path,
    model_name=args.base_model,
    recipe_name="understudy_bakeoff_oracle_sft",
    renderer_name=args.renderer,
    dataset_builder=FromConversationFileBuilder(
        file_path=str(trajectories),
        common_config=ChatDatasetBuilderCommonConfig(
            model_name_for_tokenizer=args.base_model,
            renderer_name=args.renderer,
            max_length=args.max_length,
            batch_size=args.batch_size,
            train_on_what=TrainOnWhat.LAST_ASSISTANT_MESSAGE,
        ),
    ),
    learning_rate=args.learning_rate,
    lora_rank=args.lora_rank,
    num_epochs=args.epochs,
    max_steps=args.max_steps,
    evaluator_builders=[],
    infrequent_evaluator_builders=[],
    save_every=0,
    eval_every=0,
    infrequent_eval_every=0,
)

started = time.time()
asyncio.run(train_sft.main(config))
elapsed = round(time.time() - started, 1)


def final_checkpoint(directory: str) -> tuple[str | None, str | None]:
    log = Path(directory) / "checkpoints.jsonl"
    if not log.exists():
        return None, None
    entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    if not entries:
        return None, None
    last = entries[-1]
    return last.get("sampler_path") or last.get("path"), last.get("state_path")


sampler_path, state_path = final_checkpoint(log_path)
if not sampler_path:
    raise SystemExit(f"training produced no checkpoint under {log_path}")


receipt = {
    "schema_version": "understudy.bakeoff.train_receipt.v1",
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "rung": "sft",
    "backend": "tinker",
    "base_model": args.base_model,
    "renderer": args.renderer,
    "trajectories_path": str(trajectories),
    "trajectories_sha256": data_sha256,
    "examples": len(rows),
    "trajectories": manifest.get("trajectories"),
    "contract_sha256": manifest.get("contract_sha256"),
    "fixture_sha256": manifest.get("fixture_sha256"),
    "train_split_sha256": manifest.get("split_sha256"),
    "hyperparameters": {
        "lora_rank": args.lora_rank,
        "learning_rate": args.learning_rate,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "max_length": args.max_length,
        "max_steps": args.max_steps,
        "train_on_what": "last_assistant_message",
    },
    "log_path": log_path,
    "checkpoint": sampler_path,
    "state_checkpoint": state_path,
    "wall_clock_s": elapsed,
}
out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt, indent=2))
