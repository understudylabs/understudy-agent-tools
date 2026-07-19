export const localSftEvaluationRuntimeSource = String.raw`#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any


FINAL_ANSWER = re.compile(r"####\s*([-+]?(?:\d[\d,]*)(?:\.\d+)?)\s*$")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def final_answer(value: str) -> str | None:
    match = FINAL_ANSWER.search(value.strip())
    if not match:
        return None
    normalized = match.group(1).replace(",", "")
    try:
        number = float(normalized)
    except ValueError:
        return None
    return str(int(number)) if number.is_integer() else format(number, ".12g")


def prompt_tokens(tokenizer: Any, messages: list[dict[str, str]]) -> list[int]:
    try:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            enable_thinking=False,
        )


def example_tokens(tokenizer: Any, messages: list[dict[str, str]]) -> list[int]:
    try:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=False,
            enable_thinking=False,
        )
    except TypeError:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=False,
        )


def preflight(tokenizer: Any, request: dict[str, Any]) -> None:
    maximum = int(request["max_context_length"])
    for artifact in request["preflight_artifacts"]:
        path = Path(artifact["path"])
        raw = path.read_bytes()
        if sha256_bytes(raw) != artifact["sha256"]:
            raise ValueError(f"{artifact['artifact_role']} split changed after plan approval")
        rows = 0
        for index, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            messages = row.get("messages")
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError(f"{artifact['artifact_role']} row {index} has no chat messages")
            token_count = len(example_tokens(tokenizer, messages))
            if token_count > maximum:
                raise ValueError(
                    f"{artifact['artifact_role']} row {index} needs {token_count} tokens; "
                    f"the approved maximum is {maximum}"
                )
            rows += 1
        if rows != artifact["row_count"]:
            raise ValueError(f"{artifact['artifact_role']} row count changed after plan approval")
    except TypeError:
        return tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
        )


def evaluate(request: dict[str, Any]) -> dict[str, Any]:
    from mlx_lm import batch_generate, load

    heldout_path = Path(request["heldout_path"])
    raw = heldout_path.read_bytes()
    if sha256_bytes(raw) != request["heldout_sha256"]:
        raise ValueError("held-out split changed after plan approval")

    prompts: list[list[int]] = []
    expected: list[str] = []
    example_ids: list[str] = []
    rows = 0
    model, tokenizer = load(
        request["model"],
        adapter_path=request.get("adapter_path"),
        lazy=False,
    )
    preflight(tokenizer, request)
    for index, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        messages = row.get("messages")
        if not isinstance(messages, list) or len(messages) < 2:
            raise ValueError(f"held-out row {index} has no chat messages")
        answer = messages[-1]
        if not isinstance(answer, dict) or answer.get("role") != "assistant":
            raise ValueError(f"held-out row {index} has no assistant target")
        target = final_answer(str(answer.get("content", "")))
        if target is None:
            raise ValueError(f"held-out row {index} has no strict final answer")
        prompt_messages = messages[:-1]
        prompt_bytes = json.dumps(prompt_messages, sort_keys=True, separators=(",", ":")).encode("utf-8")
        prompts.append(prompt_tokens(tokenizer, prompt_messages))
        expected.append(target)
        example_ids.append(sha256_bytes(prompt_bytes)[:16])
        rows += 1

    if rows != request["heldout_rows"]:
        raise ValueError("held-out row count changed after plan approval")

    started = time.perf_counter()
    response = batch_generate(
        model,
        tokenizer,
        prompts,
        max_tokens=int(request.get("max_tokens", 128)),
        verbose=False,
    )
    outputs = list(response.texts)
    predictions: list[dict[str, Any]] = []
    correct = 0
    for example_id, target, output in zip(example_ids, expected, outputs, strict=True):
        actual = final_answer(output)
        passed = actual == target
        correct += int(passed)
        predictions.append({
            "example_id": example_id,
            "expected": target,
            "actual": actual,
            "correct": passed,
        })
    return {
        "schema_version": "understudy.local_sft.evaluation.v1",
        "recipe_id": request["recipe_id"],
        "evaluator": request["evaluator"],
        "heldout_sha256": request["heldout_sha256"],
        "examples": rows,
        "correct": correct,
        "score": correct / rows if rows else 0.0,
        "wall_seconds": time.perf_counter() - started,
        "predictions": predictions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    result = evaluate(read_json(Path(args.request)))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
`;
