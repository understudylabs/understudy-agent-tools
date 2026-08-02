"""Train-only GEPA-style prompt suffix optimization for the Tinker runner."""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import close_service, get_service
from evaluate import _enable_system_certificates_for_tinker
from rollout import (
    MODEL_NAME,
    RENDERER_NAME,
    RolloutConfig,
    parse_agent_action,
    rollout_task,
)

REPO = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
REFLECTION_MODEL = "claude-sonnet-4-6"
MAX_ITERATIONS = 8
MINIBATCH_SIZE = 8
MAX_MODEL_TURNS = 12
REFLECTION_MAX_TOKENS = 1200


@dataclass
class Candidate:
    candidate_id: str
    suffix: str
    iteration: int
    train_scores: dict[str, float]
    sampled_tokens: int = 0
    prompt_tokens: int = 0
    rollouts: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def train_mean(self) -> float:
        return statistics.fmean(self.train_scores.values()) if self.train_scores else 0.0


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=MAX_ITERATIONS)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--reflection-model", default=REFLECTION_MODEL)
    return parser.parse_args()


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _action_sequence(record: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for message in record.get("messages", []):
        if message.get("role") != "assistant":
            continue
        action = parse_agent_action(message.get("content", ""))
        actions.append(action)
    return actions


def _diagnostics(record: dict[str, Any]) -> list[str]:
    diagnostics: list[str] = []
    if record.get("parse_errors"):
        diagnostics.append("malformed_or_unparseable_action_json")
    if record.get("finished_explicitly") and record.get("reward", 0.0) < 1.0:
        diagnostics.append("premature_finish")
    if not record.get("finished_explicitly") and record.get("model_turns", 0) >= MAX_MODEL_TURNS:
        diagnostics.append("hit_turn_cap")
    if record.get("forbidden_effects"):
        diagnostics.append("forbidden_write_attempted")
    actions = _action_sequence(record)
    normalized = [
        json.dumps(action, sort_keys=True, separators=(",", ":"))
        for action in actions
        if "error" not in action
    ]
    if len(normalized) != len(set(normalized)):
        diagnostics.append("repeated_identical_calls")
    names = [action.get("name") for action in actions]
    if names and all(name == "api_search" for name in names):
        diagnostics.append("searching_without_fetching")
    if not actions:
        diagnostics.append("turns_with_no_action")
    return diagnostics


def _feedback(records: list[dict[str, Any]], task_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for record in records:
        result.append(
            {
                "task_id": record["task_id"],
                "task_prompt": task_by_id[record["task_id"]]["prompt"],
                "score": record["reward"],
                "diagnostics": _diagnostics(record),
                "actions": _action_sequence(record),
            }
        )
    return result


def _proposal_payload(
    parent: Candidate,
    feedback: list[dict[str, Any]],
    iteration: int,
) -> dict[str, Any]:
    return {
        "iteration": iteration,
        "parent_suffix": parent.suffix,
        "failures": feedback,
    }


def _anthropic_request(model: str, system: str, user: str) -> tuple[str, str, int, int]:
    key = __import__("os").environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = json.dumps(
        {
            "model": model,
            "max_tokens": REFLECTION_MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode("utf-8"))
    text = "".join(
        block.get("text", "")
        for block in payload.get("content", [])
        if block.get("type") == "text"
    ).strip()
    usage = payload.get("usage", {})
    return (
        text,
        payload.get("stop_reason", ""),
        int(usage.get("input_tokens", 0)),
        int(usage.get("output_tokens", 0)),
    )


async def propose_suffix(
    model: str,
    parent: Candidate,
    feedback: list[dict[str, Any]],
    iteration: int,
) -> tuple[str, str, int, int]:
    system = """You are a careful prompt-optimization reflection engine.
The frozen system prompt already contains the complete JSON tool-calling protocol.
Propose only a short suffix (at most 200 words) appended after that protocol.
The suffix must be general guidance, never task-specific hardcoded ids, names,
values, URLs, expected answers, or memorized action sequences.
You may use only the task prompts, observed model action sequences, scores, and
failure-mode diagnostics supplied below. Do not infer or request grader
internals. The context intentionally excludes assertions, gold values,
allowedWrites, oracle actions, and expected final states.
Return only the proposed suffix text, with no quotation marks or explanation."""
    user = json.dumps(_proposal_payload(parent, feedback, iteration), indent=2)
    for attempt in range(2):
        text, stop_reason, input_tokens, output_tokens = await asyncio.to_thread(
            _anthropic_request,
            model,
            system,
            user,
        )
        if stop_reason != "max_tokens" and stop_reason != "length":
            return text[:4000], stop_reason, input_tokens, output_tokens
        if stop_reason == "length" and attempt == 0:
            continue
    raise RuntimeError("reflection proposal ended with finish_reason=length twice")


async def _run_rollouts(
    service: Any,
    sampling_client: Any,
    renderer: Any,
    tasks: list[dict[str, Any]],
    suffix: str,
    concurrency: int,
    full_system_prompt: str | None = None,
) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(concurrency)

    async def one(task: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await rollout_task(
                service,
                sampling_client,
                renderer,
                task,
                RolloutConfig(
                    temperature=0.0,
                    system_prompt_suffix=suffix or None,
                    system_prompt=full_system_prompt,
                    max_model_turns=MAX_MODEL_TURNS,
                ),
            )

    return await asyncio.gather(*(one(task) for task in tasks))


def _record_tokens(records: list[dict[str, Any]]) -> tuple[int, int]:
    return (
        sum(sum(record["sampled_token_counts"]) for record in records),
        sum(sum(record["prompt_token_counts"]) for record in records),
    )


def _write_eval_artifact(path: Path, records: list[dict[str, Any]], label: str, hashes: dict[str, Any]) -> dict[str, Any]:
    rows = []
    for record in records:
        rows.append(
            {
                "schema_version": "understudy.eval_result.v1",
                "run_id": label,
                "task_id": record["task_id"],
                "split": record["split"],
                "score": record["reward"],
                "status": "ok",
                "model": MODEL_NAME,
                "route": "tinker",
                "benchmark_id": "automationbench-simple-api-offline",
                "subscores": {
                    "forbidden_effects": len(record["forbidden_effects"]),
                    "steps": record["env_steps"],
                },
                "provenance": {
                    "harness_sha256": hashes["fixture_sha256"],
                    "split_sha256": hashes["split_sha256"][record["split"]],
                },
                "model_turns": record["model_turns"],
                "env_steps": record["env_steps"],
                "forbidden_effects": record["forbidden_effects"],
                "parse_errors": record["parse_errors"],
                "finished_explicitly": record["finished_explicitly"],
                "messages": record["messages"],
                "sampled_token_counts": record["sampled_token_counts"],
                "prompt_token_counts": record["prompt_token_counts"],
            }
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )
    sampled, prompt = _record_tokens(records)
    summary = {
        "label": label,
        "split": records[0]["split"] if records else None,
        "task_count": len(records),
        "mean_reward": statistics.fmean(record["reward"] for record in records) if records else 0.0,
        "parse_error_rate": (
            sum(bool(record["parse_errors"]) for record in records) / len(records)
            if records
            else 0.0
        ),
        "forbidden_write_count": sum(bool(record["forbidden_effects"]) for record in records),
        "total_sampled_tokens": sampled,
        "total_prompt_tokens": prompt,
        "records": rows,
    }
    path.with_suffix(".summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return summary


async def _run(args: argparse.Namespace) -> None:
    if args.iterations < 1 or args.iterations > MAX_ITERATIONS:
        raise SystemExit(f"--iterations must be between 1 and {MAX_ITERATIONS}")
    rng = random.Random(args.seed)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    train_baseline_path = ARTIFACTS / "cell-a-base-baseline-train.jsonl"
    if not train_baseline_path.exists():
        raise SystemExit("Part A baseline artifact is required before GEPA")
    baseline_records = _load_jsonl(train_baseline_path)
    for record in baseline_records:
        record["reward"] = record["score"]
    baseline_scores = {record["task_id"]: float(record["score"]) for record in baseline_records}
    baseline_sampled = sum(sum(record["sampled_token_counts"]) for record in baseline_records)
    baseline_prompt = sum(sum(record["prompt_token_counts"]) for record in baseline_records)

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
        train_scores=baseline_scores,
        sampled_tokens=baseline_sampled,
        prompt_tokens=baseline_prompt,
        rollouts=len(baseline_records),
    )
    pool = [baseline]
    cumulative_rollouts = baseline.rollouts
    cumulative_sampled = baseline.sampled_tokens
    cumulative_prompt = baseline.prompt_tokens
    reflection_input = 0
    reflection_output = 0
    log_path = ARTIFACTS / "gepa-log.jsonl"
    log_path.write_text("", encoding="utf-8")
    (ARTIFACTS / "gepa-candidates.jsonl").write_text("", encoding="utf-8")

    for iteration in range(1, args.iterations + 1):
        eligible = []
        for candidate in pool:
            if any(
                candidate.train_scores.get(task["task_id"], -1.0)
                >= max(other.train_scores.get(task["task_id"], -1.0) for other in pool)
                for task in tasks
            ):
                eligible.append(candidate)
        parent = rng.choice(eligible or [max(pool, key=lambda candidate: candidate.train_mean)])
        start = ((iteration - 1) * MINIBATCH_SIZE) % len(tasks)
        indices = [(start + offset) % len(tasks) for offset in range(MINIBATCH_SIZE)]
        rng.shuffle(indices)
        minibatch = [tasks[index] for index in indices]

        if parent.candidate_id == "empty":
            by_id = {record["task_id"]: record for record in baseline_records}
            parent_records = [by_id[task["task_id"]] for task in minibatch]
        else:
            parent_records = await _run_rollouts(
                service,
                sampling_client,
                renderer,
                minibatch,
                parent.suffix,
                args.concurrency,
            )
            cumulative_rollouts += len(parent_records)
            sampled, prompt = _record_tokens(parent_records)
            cumulative_sampled += sampled
            cumulative_prompt += prompt
        parent_mean = statistics.fmean(record["reward"] for record in parent_records)
        feedback = _feedback(parent_records, task_by_id)
        suffix, finish_reason, input_tokens, output_tokens = await propose_suffix(
            args.reflection_model,
            parent,
            feedback,
            iteration,
        )
        reflection_input += input_tokens
        reflection_output += output_tokens
        child_records = await _run_rollouts(
            service,
            sampling_client,
            renderer,
            minibatch,
            suffix,
            args.concurrency,
        )
        cumulative_rollouts += len(child_records)
        child_sampled, child_prompt = _record_tokens(child_records)
        cumulative_sampled += child_sampled
        cumulative_prompt += child_prompt
        child_mean = statistics.fmean(record["reward"] for record in child_records)
        accepted = child_mean >= parent_mean
        child = None
        full_summary = None
        if accepted:
            full_records = await _run_rollouts(
                service,
                sampling_client,
                renderer,
                tasks,
                suffix,
                args.concurrency,
            )
            cumulative_rollouts += len(full_records)
            full_sampled, full_prompt = _record_tokens(full_records)
            cumulative_sampled += full_sampled
            cumulative_prompt += full_prompt
            child = Candidate(
                candidate_id=f"iter-{iteration}-{uuid.uuid4().hex[:8]}",
                suffix=suffix,
                iteration=iteration,
                train_scores={record["task_id"]: record["reward"] for record in full_records},
                sampled_tokens=full_sampled,
                prompt_tokens=full_prompt,
                rollouts=len(full_records),
            )
            pool.append(child)
            full_summary = _write_eval_artifact(
                ARTIFACTS / f"gepa-{child.candidate_id}-train.jsonl",
                full_records,
                child.candidate_id,
                hashes,
            )
        event = {
            "iteration": iteration,
            "parent_id": parent.candidate_id,
            "minibatch_task_ids": [task["task_id"] for task in minibatch],
            "parent_minibatch_mean": parent_mean,
            "child_minibatch_mean": child_mean,
            "proposed_suffix": suffix,
            "finish_reason": finish_reason,
            "accepted": accepted,
            "full_train_mean": child.train_mean if child else None,
            "cumulative_rollout_count": cumulative_rollouts,
            "cumulative_sampled_tokens": cumulative_sampled,
            "cumulative_prompt_tokens": cumulative_prompt,
            "reflection_input_tokens": input_tokens,
            "reflection_output_tokens": output_tokens,
            "reflection_total_input_tokens": reflection_input,
            "reflection_total_output_tokens": reflection_output,
            "full_train_summary": full_summary,
        }
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        if child:
            with (ARTIFACTS / "gepa-candidates.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "candidate_id": child.candidate_id,
                            "iteration": child.iteration,
                            "suffix": child.suffix,
                            "train_mean": child.train_mean,
                            "train_scores": child.train_scores,
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )
        print(json.dumps(event), flush=True)

    top = sorted(pool[1:], key=lambda candidate: (-candidate.train_mean, candidate.iteration))[:3]
    selection_candidates = [baseline, *top]
    dev_baseline_path = ARTIFACTS / "cell-a-base-baseline-dev.jsonl"
    dev_rows = _load_jsonl(dev_baseline_path)
    selection_rows = [
        {
            "candidate_id": baseline.candidate_id,
            "suffix": baseline.suffix,
            "dev_mean": statistics.fmean(row["score"] for row in dev_rows),
            "sampled_tokens": sum(sum(row["sampled_token_counts"]) for row in dev_rows),
            "prompt_tokens": sum(sum(row["prompt_token_counts"]) for row in dev_rows),
            "iteration": 0,
            "artifact": str(dev_baseline_path),
        }
    ]
    for candidate in top:
        dev_tasks = service.tasks("dev")
        records = await _run_rollouts(
            service,
            sampling_client,
            renderer,
            dev_tasks,
            candidate.suffix,
            args.concurrency,
        )
        cumulative_rollouts += len(records)
        sampled, prompt = _record_tokens(records)
        cumulative_sampled += sampled
        cumulative_prompt += prompt
        artifact = ARTIFACTS / f"gepa-{candidate.candidate_id}-dev.jsonl"
        _write_eval_artifact(artifact, records, candidate.candidate_id, hashes)
        selection_rows.append(
            {
                "candidate_id": candidate.candidate_id,
                "suffix": candidate.suffix,
                "dev_mean": statistics.fmean(record["reward"] for record in records),
                "sampled_tokens": sampled,
                "prompt_tokens": prompt,
                "iteration": candidate.iteration,
                "artifact": str(artifact),
            }
        )
    winner = sorted(
        selection_rows,
        key=lambda row: (-row["dev_mean"], row["sampled_tokens"], row["iteration"]),
    )[0]
    (ARTIFACTS / "gepa-prompt.txt").write_text(winner["suffix"], encoding="utf-8")
    (ARTIFACTS / "gepa-selection.json").write_text(
        json.dumps(
            {
                "winner": winner,
                "candidates": selection_rows,
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
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "winner": winner["candidate_id"],
                "dev_mean": winner["dev_mean"],
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
    args = _args()
    try:
        asyncio.run(_run(args))
    finally:
        close_service()


if __name__ == "__main__":
    main()
