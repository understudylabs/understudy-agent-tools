export const tinkerSftRuntimeSource = String.raw`from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def emit(value: dict) -> None:
    print(json.dumps(value, separators=(",", ":")), flush=True)


def read_jsonl(path: str) -> list[dict]:
    rows = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def final_answer(value: str) -> str | None:
    matches = re.findall(r"####\s*(-?[\d,]+)", value)
    return matches[-1].replace(",", "") if matches else None


def text_content(message) -> str:
    from tinker_cookbook.renderers import get_text_content
    return get_text_content(message)


def price(catalog: dict, model: str) -> dict:
    for entry in catalog["entries"]:
        if entry["model"] == model:
            return entry
    raise RuntimeError("Selected model has no approved price basis.")


def selected_model(request: dict, supported: dict[str, int | None]) -> str:
    requested = request.get("requested_model")
    catalog = sorted(request["price_catalog"]["entries"], key=lambda item: item["preference"])
    if requested:
        if requested not in supported:
            raise RuntimeError("Requested Tinker model is not in the live provider catalog.")
        if supported[requested] is not None and supported[requested] < request["max_context_length"]:
            raise RuntimeError("Requested Tinker model cannot fit the approved context length.")
        price(request["price_catalog"], requested)
        return requested
    for entry in catalog:
        maximum = supported.get(entry["model"])
        if entry["model"] in supported and (maximum is None or maximum >= request["max_context_length"]):
            return entry["model"]
    raise RuntimeError("No live Tinker model has a current approved price basis.")


def dollars(tokens: int, rate: float) -> float:
    return tokens * rate / 1_000_000


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


async def evaluate(client, renderer, rows: list[dict], max_tokens: int, seed: int) -> dict:
    import tinker

    predictions = []
    correct = 0
    prompt_tokens = 0
    generated_tokens = 0
    started = time.time()
    for index, row in enumerate(rows):
        messages = row["messages"]
        expected = final_answer(str(messages[-1]["content"]))
        prompt = renderer.build_generation_prompt(messages[:-1])
        prompt_tokens += int(prompt.length)
        result = await client.sample_async(
            prompt=prompt,
            num_samples=1,
            sampling_params=tinker.SamplingParams(
                max_tokens=max_tokens,
                temperature=0.0,
                seed=seed + index,
                stop=renderer.get_stop_sequences(),
            ),
        )
        sequence = result.sequences[0]
        generated_tokens += len(sequence.tokens)
        message, termination = renderer.parse_response(sequence.tokens)
        actual = final_answer(text_content(message))
        is_correct = actual is not None and actual == expected
        correct += int(is_correct)
        predictions.append({
            "example_id": hashlib.sha256(json.dumps(messages[:-1], sort_keys=True).encode()).hexdigest()[:24],
            "expected": expected,
            "actual": actual,
            "correct": is_correct,
            "parse_termination": termination.value,
        })
    return {
        "examples": len(rows),
        "correct": correct,
        "score": correct / len(rows),
        "prompt_tokens": prompt_tokens,
        "generated_tokens": generated_tokens,
        "wall_seconds": round(time.time() - started, 3),
        "predictions": predictions,
    }


async def main(request: dict) -> dict:
    import tinker
    from tinker_cookbook import model_info, renderers
    from tinker_cookbook.supervised.data import conversation_to_datum
    from tinker_cookbook.tokenizer_utils import get_tokenizer

    if not os.environ.get("TINKER_API_KEY"):
        raise RuntimeError("TINKER_API_KEY is required for Tinker execution.")
    if instant(request["price_catalog"]["expires_at"]) <= instant(request["started_at"]):
        raise RuntimeError("The bundled Tinker price basis is stale; update it before spending.")
    lora_scope = request["lora_scope"]
    if not any(lora_scope[name] for name in ("train_attn", "train_mlp", "train_unembed")):
        raise RuntimeError("The approved LoRA scope trains no module family.")

    emit({"type": "phase", "phase": "preparing", "message": "Checking the live Tinker model catalog and renderer."})
    service = tinker.ServiceClient(user_metadata={"understudy_run": request["run_id"]})
    capabilities = await service.get_server_capabilities_async()
    supported = {
        item.model_name: item.max_context_length
        for item in capabilities.supported_models
        if item.model_name
    }
    model = selected_model(request, supported)
    rates = price(request["price_catalog"], model)
    tokenizer = get_tokenizer(model)
    renderer_name = model_info.get_recommended_renderer_name(model)
    renderer = renderers.get_renderer(renderer_name, tokenizer)
    train_rows = read_jsonl(request["artifacts"]["train"]["path"])
    heldout_rows = read_jsonl(request["artifacts"]["heldout"]["path"])[
        : request["maximum_eval_examples"]
    ]
    train_datums = [
        conversation_to_datum(
            row["messages"],
            renderer,
            max_length=request["max_context_length"],
            train_on_what=renderers.TrainOnWhat.LAST_ASSISTANT_MESSAGE,
        )
        for row in train_rows
    ]
    prompt_inputs = [renderer.build_generation_prompt(row["messages"][:-1]) for row in heldout_rows]
    train_tokens = sum(int(datum.model_input.length) for datum in train_datums) * request["epochs"]
    eval_prompt_tokens = sum(int(prompt.length) for prompt in prompt_inputs) * 2
    eval_generation_tokens = len(heldout_rows) * request["max_generation_tokens"] * 2
    maximum_cost = (
        dollars(train_tokens, rates["train_usd_per_million"])
        + dollars(eval_prompt_tokens, rates["prefill_usd_per_million"])
        + dollars(eval_generation_tokens, rates["sample_usd_per_million"])
        + request["price_catalog"]["checkpoint_storage_reserve_usd"]
    )
    if not math.isfinite(maximum_cost) or maximum_cost > request["maximum_spend_usd"]:
        raise RuntimeError(
            "Tinker worst-case cost USD {:.6f} exceeds approved USD {:.2f}.".format(
                maximum_cost, request["maximum_spend_usd"]
            )
        )
    emit({
        "type": "phase",
        "phase": "baseline",
        "message": f"Evaluating the live base model on {len(heldout_rows)} held-out examples.",
        "model": model,
        "maximum_cost_usd": round(maximum_cost, 6),
    })
    base_client = await service.create_sampling_client_async(base_model=model)
    baseline = await evaluate(base_client, renderer, heldout_rows, request["max_generation_tokens"], 44)

    emit({"type": "phase", "phase": "training", "message": "Running bounded assistant-only LoRA SFT."})
    training_client = await service.create_lora_training_client_async(
        base_model=model,
        rank=request["lora_rank"],
        seed=44,
        train_attn=lora_scope["train_attn"],
        train_mlp=lora_scope["train_mlp"],
        train_unembed=lora_scope["train_unembed"],
        user_metadata={"understudy_run": request["run_id"], "recipe_id": request["recipe_id"]},
    )
    batch_size = min(8, max(1, int(getattr(capabilities, "max_batch_size", 8) or 8)))
    steps = 0
    for epoch in range(request["epochs"]):
        for start in range(0, len(train_datums), batch_size):
            batch = train_datums[start : start + batch_size]
            fwd = await training_client.forward_backward_async(batch, "cross_entropy")
            opt = await training_client.optim_step_async(
                tinker.AdamParams(learning_rate=request["learning_rate"])
            )
            await fwd.result_async()
            await opt.result_async()
            steps += 1
            emit({
                "type": "phase",
                "phase": "training",
                "message": "Training on the approved split.",
                "current": steps,
                "total": math.ceil(len(train_datums) / batch_size) * request["epochs"],
            })

    emit({"type": "phase", "phase": "checkpointing", "message": "Saving a non-expiring resumable state before creating bounded sampler weights."})
    training_state = training_client.save_state(
        name=f"understudy-{request['run_id'][:32]}-state", ttl_seconds=None
    ).result()
    emit({"type": "phase", "phase": "evaluating", "message": "Saving 24-hour sampler weights and re-running the same holdout."})
    saved = training_client.save_weights_for_sampler(
        name=f"understudy-{request['run_id'][:32]}-sampler", ttl_seconds=86400
    ).result()
    tuned_client = await service.create_sampling_client_async(model_path=saved.path)
    heldout = await evaluate(tuned_client, renderer, heldout_rows, request["max_generation_tokens"], 44)
    actual_cost = (
        dollars(train_tokens, rates["train_usd_per_million"])
        + dollars(baseline["prompt_tokens"] + heldout["prompt_tokens"], rates["prefill_usd_per_million"])
        + dollars(baseline["generated_tokens"] + heldout["generated_tokens"], rates["sample_usd_per_million"])
        + request["price_catalog"]["checkpoint_storage_reserve_usd"]
    )
    delta = heldout["score"] - baseline["score"]
    promoted = (
        heldout["score"] >= request["minimum_accuracy"]
        and delta >= request["minimum_improvement_over_base"]
    )
    return {
        "schema_version": "understudy.tinker_sft.run.v1",
        "run_id": request["run_id"],
        "status": "completed",
        "plan_id": request["plan_id"],
        "plan_path": request["plan_path"],
        "plan_sha256": request["plan_sha256"],
        "split_hash": request["split_hash"],
        "recipe_id": request["recipe_id"],
        "evaluator": request["evaluator"],
        "heldout_sha256": request["artifacts"]["heldout"]["sha256"],
        "backend": "tinker",
        "model": model,
        "renderer": renderer_name,
        "training_state_path": training_state.path,
        "training_state_ttl_seconds": None,
        "sampler_state_path": saved.path,
        "checkpoint_ttl_seconds": 86400,
        "training": {
            "steps": steps,
            "tokens": train_tokens,
            "loss_mask": "last_assistant_message",
            "lora_scope": lora_scope,
        },
        "baseline": baseline,
        "heldout": heldout,
        "improvement": {"absolute_score_delta": delta, "improved": delta > 0},
        "promotion": {"status": "promoted" if promoted else "needs_work"},
        "cost": {
            "approved_max_usd": request["maximum_spend_usd"],
            "worst_case_usd": round(maximum_cost, 6),
            "actual_estimated_usd": round(actual_cost, 6),
            "price_source": request["price_catalog"]["source_url"],
            "price_checked_at": request["price_catalog"]["checked_at"],
        },
        "privacy": {
            "provider_called": True,
            "provider_training_data_sent": True,
            "raw_artifact_uploaded": False,
            "remote_job_created": True,
            "understudy_telemetry_sent": False,
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    with Path(args.request).open("r", encoding="utf-8") as handle:
        request = json.load(handle)
    try:
        result = asyncio.run(main(request))
        emit({"type": "result", "result": result})
    except Exception as error:
        print(f"Tinker SFT failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
`;
