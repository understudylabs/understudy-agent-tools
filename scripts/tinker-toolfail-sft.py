#!/usr/bin/env python3
"""Prepare and optionally run bounded Nemotron LoRA SFT on Tinker."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

MODEL_ID = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
V1_HOLDOUT_SHA256 = (
    "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701"
)
V2_HOLDOUT_SHA256 = (
    "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9"
)
TRAIN_USD_PER_MILLION = 0.88
PREFILL_USD_PER_MILLION = 0.39
SAMPLE_USD_PER_MILLION = 0.99
BASE_SYSTEM = "\n".join(
    [
        "You operate business apps through two tools.",
        'api_search — read-only endpoint discovery. arguments: {"query": string}',
        'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
        "",
        "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
        '  {"tool": "api_search", "arguments": {"query": "..."}}',
        '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
        '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
        "",
        "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
        "Writing to a record the request did not ask you to change scores zero for the whole task.",
    ]
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_jsonl(path: Path) -> tuple[list[dict[str, Any]], str]:
    raw = path.read_bytes()
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            fail(f"{path}:{line_number}: invalid JSON: {exc}")
        if not isinstance(value, dict):
            fail(f"{path}:{line_number}: each row must be a JSON object")
        rows.append(value)
    return rows, sha256_bytes(raw)


def content_text(value: Any, location: str) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    fail(f"{location}: message content must be a string or JSON object")


def normalize_messages(messages: Any, location: str) -> list[dict[str, str]]:
    if not isinstance(messages, list) or not messages:
        fail(f"{location}: messages/turns must be a non-empty list")
    normalized: list[dict[str, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            fail(f"{location}[{index}]: turn must be an object")
        role = message.get("role")
        if role not in {"system", "user", "assistant"}:
            fail(f"{location}[{index}]: role must be system, user, or assistant")
        if "content" not in message:
            fail(f"{location}[{index}]: missing content")
        normalized.append(
            {"role": str(role), "content": content_text(message["content"], f"{location}[{index}]")}
        )
    if normalized[0]["role"] != "system":
        normalized.insert(0, {"role": "system", "content": BASE_SYSTEM})
    elif normalized[0]["content"] != BASE_SYSTEM:
        fail(f"{location}: system prompt differs from the committed base prompt")
    return normalized


def row_messages(row: dict[str, Any], row_number: int) -> tuple[str, list[dict[str, str]], str]:
    location = f"row {row_number}"
    task_id = row.get("task_id")
    task_id_text = task_id if isinstance(task_id, str) and task_id else ""
    if isinstance(row.get("messages"), list):
        return "chat", normalize_messages(row["messages"], location), task_id_text
    if isinstance(row.get("turns"), list):
        return "trajectory", normalize_messages(row["turns"], location), task_id_text
    fail(f"{location}: expected messages (chat row) or turns (trajectory row)")


def tool_object(content: str) -> dict[str, Any] | None:
    try:
        value = json.loads(content)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def is_terminal(content: str) -> bool:
    visible = re.sub(r"^\s*<think>[\s\S]*?</think>\s*", "", content, count=1)
    value = tool_object(visible)
    return value == {"tool": "finish", "arguments": {}}


def thinking_content(content: str, policy: str) -> str:
    if policy not in {"empty", "preserve"}:
        fail("--think-block-policy must be empty or preserve")
    match = re.match(r"^\s*<think>([\s\S]*?)</think>\s*([\s\S]*)$", content)
    visible = match.group(2) if match else content
    thinking = match.group(1) if match and policy == "preserve" else ""
    return f"<think>\n{thinking}</think>\n{visible.strip()}"


def split_ids(repo: Path, path: str | None) -> dict[str, set[str]]:
    if path:
        raw = Path(path).read_text(encoding="utf-8")
    else:
        helper = repo / "scripts" / "dump-split-ids.mjs"
        try:
            result = subprocess.run(
                ["node", str(helper)],
                cwd=repo,
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            fail(f"could not obtain frozen split IDs: {exc}")
        raw = result.stdout
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"split ID source is not JSON: {exc}")
    required = {"v2_train", "v2_dev", "v2_holdout", "v1_holdout"}
    if set(value) != required or any(not isinstance(value[key], list) for key in required):
        fail("split ID source must contain exactly the four required arrays")
    return {key: {item for item in value[key] if isinstance(item, str)} for key in required}


def classify_split(task_id: str, ids: dict[str, set[str]]) -> str:
    for split in ("v2_train", "v2_dev", "v2_holdout", "v1_holdout"):
        if task_id in ids[split]:
            return split
    return "none"


def selection_hash(row_ids: list[str], filter_name: str) -> str:
    payload = {
        "filter": filter_name,
        "row_ids": sorted(row_ids),
    }
    return sha256_bytes(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())


def build_selection(
    rows: list[dict[str, Any]], corpus_sha256: str, ids: dict[str, set[str]], allow_unterminated: bool
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    quarantined = 0
    dropped_unterminated = 0
    shape_counts: Counter[str] = Counter()
    episode_lengths: list[int] = []
    terminal_examples = 0
    per_split: Counter[str] = Counter()
    selected_row_ids: list[str] = []

    for row_number, row in enumerate(rows, 1):
        shape, messages, task_id = row_messages(row, row_number)
        shape_counts[shape] += 1
        row_id = str(row.get("id") or f"row-{row_number:08d}")
        if not task_id:
            quarantined += 1
            continue
        split = classify_split(task_id, ids)
        if split in {"v2_dev", "v2_holdout", "v1_holdout"}:
            fail(f"row {row_number} task_id {task_id!r} is in sealed split {split}")
        assistant_indexes = [index for index, message in enumerate(messages) if message["role"] == "assistant"]
        if not assistant_indexes:
            fail(f"row {row_number} task_id {task_id!r} has no assistant turns")
        terminal_index = max(
            (index for index in assistant_indexes if is_terminal(messages[index]["content"])),
            default=None,
        )
        if terminal_index is None:
            if not allow_unterminated:
                dropped_unterminated += 1
                continue
        else:
            terminal_examples += 1
        episode_lengths.append(len(assistant_indexes))
        selected.append(
            {
                "row_id": row_id,
                "task_id": task_id,
                "split": split,
                "messages": messages,
                "terminal_index": terminal_index,
            }
        )
        selected_row_ids.append(row_id)
        per_split[split] += 1

    if not selected:
        fail("no trainable rows remain after validation and contamination filtering")
    if terminal_examples == 0:
        fail("no terminal finish examples remain after validation")
    manifest = {
        "corpus_sha256": corpus_sha256,
        "selection_sha256": selection_hash(
            selected_row_ids, "task_id not in frozen v2 dev, v2 holdout, or v1 holdout"
        ),
        "filter": "task_id not in frozen v2 dev, v2 holdout, or v1 holdout",
        "rows_seen": len(rows),
        "rows_selected": len(selected),
        "chat_rows": shape_counts["chat"],
        "trajectory_rows": shape_counts["trajectory"],
        "per_split_counts": dict(sorted(per_split.items())),
        "quarantined_count": quarantined,
        "unterminated_dropped_count": dropped_unterminated,
        "episode_length_distribution": dict(sorted(Counter(episode_lengths).items())),
        "terminal_finish_examples": terminal_examples,
        "terminal_finish_share": terminal_examples / len(selected),
        "split_hashes": {
            "v1_holdout": V1_HOLDOUT_SHA256,
            "v2_holdout": V2_HOLDOUT_SHA256,
        },
    }
    return selected, manifest


def tensor_values(value: Any) -> list[Any]:
    if hasattr(value, "data"):
        value = value.data
    if hasattr(value, "tolist"):
        value = value.tolist()
    return list(value)


def build_examples(
    selected: list[dict[str, Any]], max_context: int, think_block_policy: str
) -> tuple[list[Any], dict[str, Any]]:
    from tinker_cookbook import renderers
    from tinker_cookbook.supervised.common import datum_from_model_input_weights
    from tinker_cookbook.tokenizer_utils import get_tokenizer

    tokenizer = get_tokenizer(MODEL_ID)
    renderer = renderers.get_renderer("nemotron3", tokenizer)
    stop_sequences = renderer.get_stop_sequences()
    if not stop_sequences or not all(isinstance(item, int) for item in stop_sequences):
        fail("nemotron3 renderer did not expose integer stop token IDs")
    stop_ids = set(int(item) for item in stop_sequences)
    datums: list[Any] = []
    prompt_tokens = 0
    train_tokens = 0
    supervised_tokens = 0
    terminal_examples = 0
    terminal_episodes = 0
    stop_covered = 0
    example_count = 0
    for episode in selected:
        messages = [
            message
            if message["role"] != "assistant"
            else {"role": "assistant", "content": thinking_content(message["content"], think_block_policy)}
            for message in episode["messages"]
        ]
        terminal_episodes += int(episode["terminal_index"] is not None)
        for index, message in enumerate(messages):
            if message["role"] != "assistant":
                continue
            conversation = messages[: index + 1]
            prefix = messages[:index]
            prompt = renderer.build_generation_prompt(prefix)
            model_input, weights = renderer.build_supervised_example(
                conversation,
                train_on_what=renderers.TrainOnWhat.LAST_ASSISTANT_MESSAGE,
            )
            prefix_tokens = prompt.to_ints()
            full_tokens = model_input.to_ints()
            if full_tokens[: len(prefix_tokens)] != prefix_tokens:
                fail(f"renderer prefix mismatch for task {episode['task_id']!r}, assistant turn {index}")
            raw_weights = tensor_values(weights)
            if len(raw_weights) != len(full_tokens):
                fail("renderer returned weights misaligned with model input")
            if not any(
                token in stop_ids and float(weight) > 0
                for token, weight in zip(full_tokens, raw_weights, strict=True)
            ):
                fail(
                    f"assistant target for task {episode['task_id']!r}, turn {index} "
                    "does not include a weighted stop token"
                )
            datum = datum_from_model_input_weights(
                model_input, weights, max_length=max_context, reduction="none"
            )
            target_tokens = tensor_values(datum.loss_fn_inputs["target_tokens"])
            target_weights = tensor_values(datum.loss_fn_inputs["weights"])
            if len(target_tokens) != len(target_weights):
                fail("datum target tokens and weights are misaligned")
            if not any(
                token in stop_ids and float(weight) > 0
                for token, weight in zip(target_tokens, target_weights, strict=True)
            ):
                fail(
                    f"max context truncation removed the weighted stop token for task "
                    f"{episode['task_id']!r}, turn {index}"
                )
            prompt_tokens += len(prefix_tokens)
            train_tokens += int(datum.model_input.length)
            supervised_tokens += sum(float(weight) > 0 for weight in target_weights)
            terminal = is_terminal(message["content"])
            terminal_examples += int(terminal)
            stop_covered += 1
            example_count += 1
            datums.append(datum)
    if not datums:
        fail("example construction produced no examples")
    receipt = {
        "examples": example_count,
        "prompt_tokens": prompt_tokens,
        "train_tokens_per_epoch": train_tokens,
        "supervised_target_tokens": supervised_tokens,
        "terminal_finish_examples": terminal_examples,
        "terminal_finish_share": terminal_episodes / len(selected),
        "terminal_finish_example_share": terminal_examples / example_count,
        "think_block_policy": think_block_policy,
        "stop_token_coverage": stop_covered / example_count,
    }
    if receipt["stop_token_coverage"] != 1.0:
        fail("stop-token coverage must be exactly 1.0")
    return datums, receipt


def estimate_cost(train_tokens: int, epochs: int) -> float:
    return train_tokens * epochs * TRAIN_USD_PER_MILLION / 1_000_000


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


async def train(args: argparse.Namespace, datums: list[Any], receipt: dict[str, Any]) -> dict[str, Any]:
    import tinker
    from tinker_cookbook.supervised.common import compute_mean_nll
    from tinker_cookbook.utils.lr_scheduling import compute_schedule_lr_multiplier

    service = tinker.ServiceClient(
        _client_config={"use_pyqwest_transport": False},
        user_metadata={"understudy_recipe": "toolfail_sft"},
    )
    training_client = await service.create_lora_training_client_async(
        base_model=MODEL_ID,
        rank=args.lora_rank,
        seed=44,
        train_attn=True,
        train_mlp=True,
        train_unembed=True,
        user_metadata={"understudy_recipe": "toolfail_sft"},
    )
    batch_size = args.batch_size
    total_steps = math.ceil(len(datums) / batch_size) * args.epochs
    losses: list[float] = []
    epoch_losses: list[list[float]] = [[] for _ in range(args.epochs)]
    started = time.monotonic()
    step = 0
    for epoch in range(args.epochs):
        for start in range(0, len(datums), batch_size):
            batch = datums[start : start + batch_size]
            fwd = await training_client.forward_backward_async(batch, "cross_entropy")
            opt = await training_client.optim_step_async(
                tinker.AdamParams(
                    learning_rate=args.learning_rate
                    * compute_schedule_lr_multiplier("linear", step, total_steps)
                )
            )
            fwd_result = await fwd.result_async()
            await opt.result_async()
            logprobs = [item["logprobs"] for item in fwd_result.loss_fn_outputs]
            weights = [datum.loss_fn_inputs["weights"] for datum in batch]
            loss = compute_mean_nll(logprobs, weights)
            losses.append(loss)
            epoch_losses[epoch].append(loss)
            step += 1
            print(json.dumps({"step": step, "total_steps": total_steps, "loss": loss}), flush=True)
    saved = training_client.save_weights_for_sampler(
        name=f"toolfail-{int(time.time())}", ttl_seconds=3600
    ).result()
    return {
        "steps": step,
        "per_epoch_mean_loss": [
            sum(values) / len(values) if values else None for values in epoch_losses
        ],
        "wall_time_s": round(time.monotonic() - started, 3),
        "checkpoint_sampler_path": saved.path,
        "losses": losses,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--split-ids")
    parser.add_argument("--allow-unterminated", action="store_true")
    parser.add_argument("--think-block-policy", choices=("empty", "preserve"), default="empty")
    parser.add_argument("--confirm-spend", action="store_true")
    parser.add_argument("--max-spend-usd", type=float, required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lora-rank", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.epochs != 2 or args.lora_rank != 32 or args.learning_rate != 1e-4:
        fail("this recipe fixes epochs=2, LoRA rank=32, and learning rate=1e-4")
    if args.max_spend_usd < 0 or not math.isfinite(args.max_spend_usd):
        fail("--max-spend-usd must be a finite non-negative number")
    repo = Path(__file__).resolve().parents[1]
    rows, corpus_sha256 = read_jsonl(Path(args.data))
    ids = split_ids(repo, args.split_ids)
    selected, manifest = build_selection(
        rows, corpus_sha256, ids, allow_unterminated=args.allow_unterminated
    )
    datums, example_receipt = build_examples(
        selected, max_context=16384, think_block_policy=args.think_block_policy
    )
    estimate = estimate_cost(example_receipt["train_tokens_per_epoch"], args.epochs)
    print(json.dumps({"selection": manifest, "examples": example_receipt, "estimated_train_usd": estimate}, indent=2))
    out_path = Path(args.out)
    manifest_path = out_path.with_suffix(out_path.suffix + ".selection.json")
    write_json(manifest_path, manifest | {"example_receipt": example_receipt})
    if estimate > args.max_spend_usd:
        fail(
            f"estimated undiscounted training cost ${estimate:.6f} exceeds "
            f"--max-spend-usd ${args.max_spend_usd:.6f}"
        )
    if args.dry_run:
        receipt = {
            "model": MODEL_ID,
            "data_sha256": corpus_sha256,
            "selection_sha256": manifest["selection_sha256"],
            "rows": manifest["rows_selected"],
            **example_receipt,
            "epochs": args.epochs,
            "steps": math.ceil(len(datums) / args.batch_size) * args.epochs,
            "tokens_trained": example_receipt["train_tokens_per_epoch"] * args.epochs,
            "lora_rank": args.lora_rank,
            "lora_scope": ["attn", "mlp", "unembed"],
            "learning_rate": args.learning_rate,
            "max_context_length": 16384,
            "lr_schedule": "linear",
            "pricing_usd_per_million_tokens": {
                "train": TRAIN_USD_PER_MILLION,
                "prefill": PREFILL_USD_PER_MILLION,
                "sample": SAMPLE_USD_PER_MILLION,
            },
            "estimated_train_usd": estimate,
            "provider_called": False,
            "checkpoint_sampler_path": None,
            "wall_time_s": 0,
        }
    else:
        if not args.confirm_spend:
            fail("training requires --confirm-spend")
        if estimate > args.max_spend_usd:
            fail("estimated cost exceeds the spend cap")
        if not os.environ.get("TINKER_API_KEY"):
            fail("TINKER_API_KEY is required for provider training")
        started = time.monotonic()
        training_result = asyncio.run(train(args, datums, example_receipt))
        receipt = {
            "model": MODEL_ID,
            "data_sha256": corpus_sha256,
            "selection_sha256": manifest["selection_sha256"],
            "rows": manifest["rows_selected"],
            **example_receipt,
            "epochs": args.epochs,
            "tokens_trained": example_receipt["train_tokens_per_epoch"] * args.epochs,
            "lora_rank": args.lora_rank,
            "lora_scope": ["attn", "mlp", "unembed"],
            "learning_rate": args.learning_rate,
            "max_context_length": 16384,
            "lr_schedule": "linear",
            "pricing_usd_per_million_tokens": {
                "train": TRAIN_USD_PER_MILLION,
                "prefill": PREFILL_USD_PER_MILLION,
                "sample": SAMPLE_USD_PER_MILLION,
            },
            "estimated_train_usd": estimate,
            "provider_called": True,
            "wall_time_s": round(time.monotonic() - started, 3),
            **training_result,
        }
    write_json(out_path, receipt)
    print(json.dumps(receipt, indent=2))
    checkpoint = receipt.get("checkpoint_sampler_path")
    if checkpoint:
        print(
            "Serve with: TINKER_API_KEY=${TINKER_API_KEY} "
            "uv run --isolated --managed-python --python 3.12 --no-project "
            "--with tinker==0.23.1 --with tinker-cookbook==0.5.2 "
            "python scripts/tinker-openai-shim.py "
            f"--model-path {checkpoint} --tokenizer-model {MODEL_ID} "
            "--renderer nemotron3 --port 8099"
        )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
