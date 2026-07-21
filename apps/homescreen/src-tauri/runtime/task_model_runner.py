#!/usr/bin/env python3
"""Fixed local runner for verified `.understudy-model` classifier bundles."""

import argparse
import json
import time
from pathlib import Path

import mlx.core as mx
from mlx_vlm import load


def truncated(ids, max_length):
    if len(ids) <= max_length:
        return ids
    tail = min(96, max_length // 4)
    return ids[: max_length - tail] + ids[-tail:]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--base-model", required=True)
    args = parser.parse_args()

    bundle = Path(args.bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    taxonomy = json.loads((bundle / manifest["scorer"]["taxonomy_path"]).read_text())
    runtime = manifest["runtime"]
    model, processor = load(
        args.base_model,
        adapter_path=str(bundle / runtime["adapter_path"]),
        lazy=True,
        strict=False,
    )
    tokenizer = getattr(processor, "tokenizer", processor)
    head = mx.load(str(bundle / runtime["classifier_head_path"]))
    weight = head["classifier.weight"].astype(mx.float32)
    bias = head["classifier.bias"].astype(mx.float32)
    l3_to_l1 = head["l3_to_l1"].tolist()
    l3_to_l2 = head["l3_to_l2"].tolist()
    paths = {int(row["l3_id"]): row for row in taxonomy["paths"]}
    max_length = int(manifest["input"]["max_length"])
    prompt_template = manifest["input"].get(
        "prompt_template", "Classify this feedback into the learned issue taxonomy.\n\n{text}"
    )
    if prompt_template.count("{text}") != 1:
        raise ValueError("input.prompt_template must contain exactly one {text} placeholder")
    top_k = int(manifest["scorer"]["top_k"])

    for line in __import__("sys").stdin:
        if not line.strip():
            continue
        row = json.loads(line)
        started = time.perf_counter()
        messages = [{"role": "user", "content": prompt_template.replace("{text}", row["text"])}]
        rendered = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        ids = tokenizer.encode(rendered, add_special_tokens=False)
        ids = truncated(ids, max_length)
        hidden = model.language_model.model(mx.array([ids]))
        last = hidden[:, -1, :].astype(mx.float32)
        logits = last @ weight.T + bias
        probabilities = mx.softmax(logits, axis=-1)[0]
        ranked = mx.argsort(probabilities)[::-1][:top_k].tolist()
        choices = []
        for l3_id in ranked:
            path = paths[int(l3_id)]
            choices.append({
                "l1_id": int(l3_to_l1[l3_id]),
                "l1": path["l1"],
                "l2_id": int(l3_to_l2[l3_id]),
                "l2": path["l2"],
                "l3_id": int(l3_id),
                "l3": path["l3"],
                "probability": float(probabilities[l3_id]),
            })
        print(json.dumps({
            "task_id": row.get("task_id"),
            "prediction": choices[0],
            "top_k": choices,
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        }), flush=True)


if __name__ == "__main__":
    main()

