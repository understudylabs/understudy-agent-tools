"""Failure-driven, full-train-gated GEPA prompt optimization."""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import uuid
from pathlib import Path
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import close_service, get_service
from evaluate import _enable_system_certificates_for_tinker
from gepa_optimize import (
    ARTIFACTS,
    MAX_ITERATIONS,
    MAX_MODEL_TURNS,
    MINIBATCH_SIZE,
    MODEL_NAME,
    RENDERER_NAME,
    Candidate,
    _action_sequence,
    _anthropic_request,
    _diagnostics,
    _feedback,
    _load_jsonl,
    _record_tokens,
    _run_rollouts,
    _write_eval_artifact,
)

REPO = Path(__file__).resolve().parents[2]
V2_PREFIX = "gepa-v2"
REFLECTION_MAX_TOKENS = 1200


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=MAX_ITERATIONS)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--reflection-model", default="claude-sonnet-4-6")
    return parser.parse_args()


async def _propose(
    model: str,
    parent: Candidate,
    feedback: list[dict[str, Any]],
    iteration: int,
) -> tuple[str, str, int, int]:
    system = """You are a careful, failure-driven prompt-optimization reflection engine.
The frozen system prompt already contains the complete JSON tool-calling protocol.
Propose only a general suffix of at most 200 words appended after that protocol.
It must generalize across every task family, including CRM and mail workflows.
Never name or hardcode record ids, contact names, email addresses, draft ids,
values, URLs specific to one task, expected answers, or memorized trajectories.
Use only the supplied task prompts, observed action sequences, scores, and
failure-mode diagnostics. Never infer grader internals: the context excludes
assertions, gold values, allowedWrites, oracle actions, and expected final state.
Pay particular attention to guarded-record forbidden writes, repeated identical
calls, hitting the turn cap, searching without fetching, and premature finish.
Return only the suffix text, with no quotation marks or explanation."""
    user = json.dumps(
        {
            "iteration": iteration,
            "parent_suffix": parent.suffix,
            "failure_cases": feedback,
            "generalization_requirement": "Address multiple families without task memorization.",
        },
        indent=2,
    )
    for attempt in range(2):
        text, stop_reason, input_tokens, output_tokens = await asyncio.to_thread(
            _anthropic_request, model, system, user
        )
        if stop_reason not in {"length", "max_tokens"}:
            return text[:4000], stop_reason, input_tokens, output_tokens
        if attempt == 0:
            continue
    raise RuntimeError("reflection proposal ended with a truncated finish reason twice")


def _choose_failure_batch(
    candidate: Candidate,
    tasks: list[dict[str, Any]],
    rng: random.Random,
) -> list[dict[str, Any]]:
    failures = [
        task for task in tasks if candidate.train_scores.get(task["task_id"], 0.0) < 1.0
    ]
    if not failures:
        return []
    if len(failures) >= MINIBATCH_SIZE:
        rng.shuffle(failures)
        return failures[:MINIBATCH_SIZE]
    selected = list(failures)
    solved = [
        task for task in tasks if candidate.train_scores.get(task["task_id"], 0.0) >= 1.0
    ]
    rng.shuffle(solved)
    target = max(6, len(failures))
    selected.extend(solved[: max(0, min(MINIBATCH_SIZE, target) - len(selected))])
    if len(selected) < MINIBATCH_SIZE:
        selected.extend(solved[len(selected) : MINIBATCH_SIZE])
    rng.shuffle(selected)
    return selected[:MINIBATCH_SIZE]


def _normalize_records(records: list[dict[str, Any]]) -> None:
    for record in records:
        if "reward" not in record and "score" in record:
            record["reward"] = record["score"]


async def _run(args: argparse.Namespace) -> None:
    if not 1 <= args.iterations <= MAX_ITERATIONS:
        raise SystemExit(f"--iterations must be between 1 and {MAX_ITERATIONS}")
    rng = random.Random(args.seed)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    baseline_train_path = ARTIFACTS / "cell-a-base-baseline-train.jsonl"
    baseline_dev_path = ARTIFACTS / "cell-a-base-baseline-dev.jsonl"
    baseline_records = _load_jsonl(baseline_train_path)
    baseline_dev_records = _load_jsonl(baseline_dev_path)
    _normalize_records(baseline_records)
    _normalize_records(baseline_dev_records)

    _enable_system_certificates_for_tinker()
    service = get_service(str(REPO))
    hashes = service.hashes()
    tasks = service.tasks("train")
    task_by_id = {task["task_id"]: task for task in tasks}
    tokenizer = get_tokenizer(MODEL_NAME)
    renderer = renderers.get_renderer(RENDERER_NAME, tokenizer, model_name=MODEL_NAME)
    service_client = tinker.ServiceClient()
    sampling_client = await service_client.create_sampling_client_async(base_model=MODEL_NAME)

    baseline = Candidate(
        candidate_id="empty",
        suffix="",
        iteration=0,
        train_scores={r["task_id"]: float(r["reward"]) for r in baseline_records},
        sampled_tokens=sum(sum(r["sampled_token_counts"]) for r in baseline_records),
        prompt_tokens=sum(sum(r["prompt_token_counts"]) for r in baseline_records),
        rollouts=len(baseline_records),
        metadata={"records": baseline_records},
    )
    pool = [baseline]
    log_path = ARTIFACTS / "gepa-v2-log.jsonl"
    candidates_path = ARTIFACTS / "gepa-v2-candidates.jsonl"
    log_path.write_text("", encoding="utf-8")
    candidates_path.write_text("", encoding="utf-8")
    cumulative_rollouts = baseline.rollouts
    cumulative_sampled = baseline.sampled_tokens
    cumulative_prompt = baseline.prompt_tokens
    reflection_input = 0
    reflection_output = 0
    stop_reason = None

    for iteration in range(1, args.iterations + 1):
        eligible = [
            candidate
            for candidate in pool
            if any(
                candidate.train_scores[task["task_id"]]
                >= max(other.train_scores[task["task_id"]] for other in pool)
                for task in tasks
            )
        ]
        parent = rng.choice(eligible or [max(pool, key=lambda c: c.train_mean)])
        minibatch = _choose_failure_batch(parent, tasks, rng)
        if not minibatch:
            stop_reason = f"parent {parent.candidate_id} has zero TRAIN failures"
            event = {
                "iteration": iteration,
                "parent_id": parent.candidate_id,
                "parent_full_train_mean": parent.train_mean,
                "minibatch_failure_task_ids": [],
                "status": "stopped",
                "stop_reason": stop_reason,
                "cumulative_rollout_count": cumulative_rollouts,
                "cumulative_sampled_tokens": cumulative_sampled,
                "cumulative_prompt_tokens": cumulative_prompt,
            }
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, separators=(",", ":")) + "\n")
            print(json.dumps(event), flush=True)
            break

        parent_records = [
            parent.metadata["records_by_id"][task["task_id"]]
            if "records_by_id" in parent.metadata
            else parent.metadata["records"][next(
                i for i, row in enumerate(parent.metadata["records"])
                if row["task_id"] == task["task_id"]
            )]
            for task in minibatch
        ]
        feedback = _feedback(parent_records, task_by_id)
        suffix, finish_reason, input_tokens, output_tokens = await _propose(
            args.reflection_model, parent, feedback, iteration
        )
        reflection_input += input_tokens
        reflection_output += output_tokens

        child_minibatch_records = await _run_rollouts(
            service, sampling_client, renderer, minibatch, suffix, args.concurrency
        )
        cumulative_rollouts += len(child_minibatch_records)
        child_mb_sampled, child_mb_prompt = _record_tokens(child_minibatch_records)
        cumulative_sampled += child_mb_sampled
        cumulative_prompt += child_mb_prompt

        child_full_records = await _run_rollouts(
            service, sampling_client, renderer, tasks, suffix, args.concurrency
        )
        cumulative_rollouts += len(child_full_records)
        child_sampled, child_prompt = _record_tokens(child_full_records)
        cumulative_sampled += child_sampled
        cumulative_prompt += child_prompt
        child_scores = {r["task_id"]: r["reward"] for r in child_full_records}
        child_mean = statistics.fmean(child_scores.values())
        accepted = child_mean >= parent.train_mean
        child = None
        if accepted:
            child = Candidate(
                candidate_id=f"v2-iter-{iteration}-{uuid.uuid4().hex[:8]}",
                suffix=suffix,
                iteration=iteration,
                train_scores=child_scores,
                sampled_tokens=child_sampled,
                prompt_tokens=child_prompt,
                rollouts=len(child_full_records),
                metadata={"records_by_id": {r["task_id"]: r for r in child_full_records}},
            )
            pool.append(child)
            _write_eval_artifact(
                ARTIFACTS / f"{child.candidate_id}-train.jsonl",
                child_full_records,
                child.candidate_id,
                hashes,
            )
            with candidates_path.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "candidate_id": child.candidate_id,
                            "iteration": iteration,
                            "suffix": suffix,
                            "train_mean": child_mean,
                            "train_scores": child_scores,
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )
        event = {
            "iteration": iteration,
            "parent_id": parent.candidate_id,
            "parent_full_train_mean": parent.train_mean,
            "minibatch_failure_task_ids": [
                task["task_id"]
                for task in minibatch
                if parent.train_scores[task["task_id"]] < 1.0
            ],
            "minibatch_task_ids": [task["task_id"] for task in minibatch],
            "child_full_train_mean": child_mean,
            "accepted": accepted,
            "proposed_suffix": suffix,
            "finish_reason": finish_reason,
            "cumulative_rollout_count": cumulative_rollouts,
            "cumulative_sampled_tokens": cumulative_sampled,
            "cumulative_prompt_tokens": cumulative_prompt,
            "reflection_input_tokens": input_tokens,
            "reflection_output_tokens": output_tokens,
        }
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        print(json.dumps(event), flush=True)

    top = sorted(pool[1:], key=lambda c: (-c.train_mean, c.iteration))[:3]
    selection_rows = [
        {
            "candidate_id": "empty",
            "suffix": "",
            "dev_mean": statistics.fmean(r["reward"] for r in baseline_dev_records),
            "sampled_tokens": sum(sum(r["sampled_token_counts"]) for r in baseline_dev_records),
            "prompt_tokens": sum(sum(r["prompt_token_counts"]) for r in baseline_dev_records),
            "iteration": 0,
            "artifact": str(baseline_dev_path),
        }
    ]
    for candidate in top:
        dev_tasks = service.tasks("dev")
        records = await _run_rollouts(
            service, sampling_client, renderer, dev_tasks, candidate.suffix, args.concurrency
        )
        cumulative_rollouts += len(records)
        sampled, prompt = _record_tokens(records)
        cumulative_sampled += sampled
        cumulative_prompt += prompt
        artifact = ARTIFACTS / f"{candidate.candidate_id}-dev.jsonl"
        _write_eval_artifact(artifact, records, candidate.candidate_id, hashes)
        selection_rows.append(
            {
                "candidate_id": candidate.candidate_id,
                "suffix": candidate.suffix,
                "dev_mean": statistics.fmean(r["reward"] for r in records),
                "sampled_tokens": sampled,
                "prompt_tokens": prompt,
                "iteration": candidate.iteration,
                "artifact": str(artifact),
            }
        )

    winner = sorted(
        selection_rows,
        key=lambda row: (
            -row["dev_mean"],
            row["sampled_tokens"] + row["prompt_tokens"],
            row["iteration"],
        ),
    )[0]
    non_empty = [row for row in selection_rows if row["suffix"]]
    best_non_empty = sorted(
        non_empty,
        key=lambda row: (
            -row["dev_mean"],
            row["sampled_tokens"] + row["prompt_tokens"],
            row["iteration"],
        ),
    )[0] if non_empty else None
    (ARTIFACTS / "gepa-v2-prompt.txt").write_text(winner["suffix"], encoding="utf-8")
    (ARTIFACTS / "gepa-v2-selection.json").write_text(
        json.dumps(
            {
                "winner": winner,
                "best_non_empty": best_non_empty,
                "candidates": selection_rows,
                "stop_reason": stop_reason,
                "total_rollouts": cumulative_rollouts,
                "total_sampled_tokens": cumulative_sampled,
                "total_prompt_tokens": cumulative_prompt,
                "reflection_input_tokens": reflection_input,
                "reflection_output_tokens": reflection_output,
                "reflection_model": args.reflection_model,
                "split": "train/dev only",
                "holdout_touched": False,
            },
            indent=2,
            sort_keys=True,
        ) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "winner": winner["candidate_id"],
                "best_non_empty": best_non_empty["candidate_id"] if best_non_empty else None,
                "total_rollouts": cumulative_rollouts,
                "total_sampled_tokens": cumulative_sampled,
                "total_prompt_tokens": cumulative_prompt,
                "reflection_input_tokens": reflection_input,
                "reflection_output_tokens": reflection_output,
            }
        ),
        flush=True,
    )


def main() -> None:
    try:
        asyncio.run(_run(_args()))
    finally:
        close_service()


if __name__ == "__main__":
    main()
