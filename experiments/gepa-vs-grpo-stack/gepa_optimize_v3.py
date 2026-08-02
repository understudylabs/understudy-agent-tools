"""GEPA v3 with the public API surface and observed tool responses."""

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
    MODEL_NAME,
    MINIBATCH_SIZE,
    RENDERER_NAME,
    Candidate,
    _action_sequence,
    _anthropic_request,
    _diagnostics,
    _load_jsonl,
    _record_tokens,
    _run_rollouts,
    _write_eval_artifact,
)
from gepa_optimize_v2 import _choose_failure_batch

REPO = Path(__file__).resolve().parents[2]
V3_PREFIX = "gepa-v3"
REFLECTION_MAX_TOKENS = 1600
LEAK_KEYS = (
    '"assertions"',
    '"gold"',
    '"allowed_writes"',
    '"allowedWrites"',
    '"oracle"',
    '"initial_state"',
    '"expected_final_state"',
)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=MAX_ITERATIONS)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--reflection-model", default="claude-sonnet-4-6")
    return parser.parse_args()


def _tool_observations(record: dict[str, Any]) -> list[str]:
    return [
        message["content"]
        for message in record.get("messages", [])
        if message.get("role") == "tool"
    ]


def _endpoint_catalog(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    endpoints: dict[str, dict[str, Any]] = {}
    for record in records:
        for content in _tool_observations(record):
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                continue
            for result in parsed.get("results", []):
                if isinstance(result, dict) and "url" in result:
                    endpoints[str(result["url"])] = result
    return list(endpoints.values())


def _public_surface(
    protocol: dict[str, Any], failure_records: list[dict[str, Any]]
) -> dict[str, Any]:
    surface = {
        "tool_catalog": protocol.get("tools", []),
        "endpoint_catalog_from_observed_api_search": _endpoint_catalog(failure_records),
        "observed_tool_responses": {
            record["task_id"]: _tool_observations(record)
            for record in failure_records
        },
    }
    serialized = json.dumps(surface, sort_keys=True)
    findings = [key for key in LEAK_KEYS if key in serialized]
    if findings:
        raise RuntimeError(f"public environment context contains grader keys: {findings}")
    return surface


def _feedback(
    records: list[dict[str, Any]],
    task_by_id: dict[str, dict[str, Any]],
    protocol: dict[str, Any],
) -> list[dict[str, Any]]:
    failures = [record for record in records if record["reward"] < 1.0]
    surface = _public_surface(protocol, failures)
    return [
        {
            "task_id": record["task_id"],
            "task_prompt": task_by_id[record["task_id"]]["prompt"],
            "score": record["reward"],
            "diagnostics": _diagnostics(record),
            "actions": _action_sequence(record),
            "observed_api_search_results_and_fetch_responses": surface[
                "observed_tool_responses"
            ][record["task_id"]],
            "tool_catalog": surface["tool_catalog"],
            "endpoint_catalog": surface["endpoint_catalog_from_observed_api_search"],
        }
        for record in failures
    ]


async def _propose(
    model: str,
    parent: Candidate,
    feedback: list[dict[str, Any]],
    iteration: int,
) -> tuple[str, str, int, int]:
    system = """You are a failure-driven prompt-optimization reflection engine.
The frozen system prompt already contains the complete JSON tool-calling protocol.
Propose only a general suffix of at most 200 words appended after that protocol.
The suffix must generalize across every task family and must not hardcode task ids,
record ids, names, email addresses, draft ids, values, or memorized trajectories.

The environment surface below is authoritative. You MUST NOT state any endpoint
path, HTTP method, or field name unless it appears verbatim in the supplied tool
catalog, endpoint catalog, or observed tool responses. Prefer teaching the agent
to use api_search and then follow the returned catalog over hard-coding paths.
Do not invent alternative endpoints. Reason from the actual errors and responses.

The supplied environment information is public tool behavior only. It contains
no assertions, gold values, allowedWrites, oracle actions, or expected final
state. Do not infer or request any grader internals. Address failures across
multiple families, including forbidden writes, repeated calls, turn caps,
search-without-fetch, and premature finish.
Return only the suffix text, with no quotation marks or explanation."""
    user = json.dumps(
        {
            "iteration": iteration,
            "parent_suffix": parent.suffix,
            "failure_cases": feedback,
            "generalization_requirement": (
                "The suffix must generalize across CRM, mail, and mixed workflows."
            ),
        },
        indent=2,
    )
    for _ in range(2):
        text, stop_reason, input_tokens, output_tokens = await asyncio.to_thread(
            _anthropic_request, model, system, user
        )
        if stop_reason not in {"length", "max_tokens"}:
            return text[:4000], stop_reason, input_tokens, output_tokens
    raise RuntimeError("reflection proposal ended with a truncated finish reason twice")


def _normalize(records: list[dict[str, Any]]) -> None:
    for record in records:
        if "reward" not in record:
            record["reward"] = record["score"]


async def _run(args: argparse.Namespace) -> None:
    if not 1 <= args.iterations <= MAX_ITERATIONS:
        raise SystemExit(f"--iterations must be between 1 and {MAX_ITERATIONS}")
    rng = random.Random(args.seed)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    baseline_path = ARTIFACTS / "cell-a-base-baseline-train.jsonl"
    baseline_dev_path = ARTIFACTS / "cell-a-base-baseline-dev.jsonl"
    baseline_records = _load_jsonl(baseline_path)
    baseline_dev_records = _load_jsonl(baseline_dev_path)
    _normalize(baseline_records)
    _normalize(baseline_dev_records)

    _enable_system_certificates_for_tinker()
    service = get_service(str(REPO))
    hashes = service.hashes()
    protocol = service.protocol()
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
        train_scores={record["task_id"]: float(record["reward"]) for record in baseline_records},
        sampled_tokens=sum(sum(record["sampled_token_counts"]) for record in baseline_records),
        prompt_tokens=sum(sum(record["prompt_token_counts"]) for record in baseline_records),
        rollouts=len(baseline_records),
        metadata={"records": baseline_records},
    )
    pool = [baseline]
    log_path = ARTIFACTS / "gepa-v3-log.jsonl"
    candidates_path = ARTIFACTS / "gepa-v3-candidates.jsonl"
    environment_path = ARTIFACTS / "gepa-v3-environment.json"
    log_path.write_text("", encoding="utf-8")
    candidates_path.write_text("", encoding="utf-8")
    cumulative_rollouts = baseline.rollouts
    cumulative_sampled = baseline.sampled_tokens
    cumulative_prompt = baseline.prompt_tokens
    reflection_input = 0
    reflection_output = 0
    surface_audit = {
        "tool_catalog": protocol.get("tools", []),
        "endpoint_catalog_source": "observed api_search results in failing rollouts",
        "environment_artifact": str(ARTIFACTS / "gepa-v3-environment.json"),
        "grader_fields_excluded": list(LEAK_KEYS),
    }

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
        parent = rng.choice(eligible or [max(pool, key=lambda item: item.train_mean)])
        minibatch = _choose_failure_batch(parent, tasks, rng)
        if not minibatch:
            event = {
                "iteration": iteration,
                "parent_id": parent.candidate_id,
                "parent_full_train_mean": parent.train_mean,
                "minibatch_failure_task_ids": [],
                "status": "stopped",
                "stop_reason": f"parent {parent.candidate_id} has zero TRAIN failures",
                "cumulative_rollout_count": cumulative_rollouts,
                "cumulative_sampled_tokens": cumulative_sampled,
                "cumulative_prompt_tokens": cumulative_prompt,
            }
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, separators=(",", ":")) + "\n")
            print(json.dumps(event), flush=True)
            break

        if "records_by_id" in parent.metadata:
            parent_records = [
                parent.metadata["records_by_id"][task["task_id"]] for task in minibatch
            ]
        else:
            by_id = {record["task_id"]: record for record in parent.metadata["records"]}
            parent_records = [by_id[task["task_id"]] for task in minibatch]
        feedback = _feedback(parent_records, task_by_id, protocol)
        if not environment_path.exists():
            environment_path.write_text(
                json.dumps(
                    {
                        "tool_catalog": feedback[0]["tool_catalog"],
                        "endpoint_catalog": feedback[0]["endpoint_catalog"],
                        "observed_tool_responses_by_failure": {
                            item["task_id"]: item[
                                "observed_api_search_results_and_fetch_responses"
                            ]
                            for item in feedback
                        },
                        "audit": {
                            "evaluator_audit_observation_leakage_findings": [],
                            "excluded_grader_fields": list(LEAK_KEYS),
                            "source": "base TRAIN failures, public tool responses only",
                        },
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
        suffix, finish_reason, input_tokens, output_tokens = await _propose(
            args.reflection_model, parent, feedback, iteration
        )
        reflection_input += input_tokens
        reflection_output += output_tokens

        child_mb = await _run_rollouts(
            service, sampling_client, renderer, minibatch, suffix, args.concurrency
        )
        child_full = await _run_rollouts(
            service, sampling_client, renderer, tasks, suffix, args.concurrency
        )
        mb_sampled, mb_prompt = _record_tokens(child_mb)
        full_sampled, full_prompt = _record_tokens(child_full)
        cumulative_rollouts += len(child_mb) + len(child_full)
        cumulative_sampled += mb_sampled + full_sampled
        cumulative_prompt += mb_prompt + full_prompt
        child_scores = {record["task_id"]: record["reward"] for record in child_full}
        child_mean = statistics.fmean(child_scores.values())
        accepted = child_mean >= parent.train_mean
        child_id = None
        if accepted:
            child_id = f"v3-iter-{iteration}-{uuid.uuid4().hex[:8]}"
            child = Candidate(
                candidate_id=child_id,
                suffix=suffix,
                iteration=iteration,
                train_scores=child_scores,
                sampled_tokens=full_sampled,
                prompt_tokens=full_prompt,
                rollouts=len(child_full),
                metadata={"records_by_id": {r["task_id"]: r for r in child_full}},
            )
            pool.append(child)
            _write_eval_artifact(
                ARTIFACTS / f"{child_id}-train.jsonl", child_full, child_id, hashes
            )
            with candidates_path.open("a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "candidate_id": child_id,
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
            "child_id": child_id,
            "proposed_suffix": suffix,
            "finish_reason": finish_reason,
            "environment_surface": surface_audit,
            "cumulative_rollout_count": cumulative_rollouts,
            "cumulative_sampled_tokens": cumulative_sampled,
            "cumulative_prompt_tokens": cumulative_prompt,
            "reflection_input_tokens": input_tokens,
            "reflection_output_tokens": output_tokens,
        }
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        print(json.dumps(event), flush=True)

    top = sorted(pool[1:], key=lambda item: (-item.train_mean, item.iteration))[:3]
    selection = [
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
        sampled, prompt = _record_tokens(records)
        cumulative_rollouts += len(records)
        cumulative_sampled += sampled
        cumulative_prompt += prompt
        artifact = ARTIFACTS / f"{candidate.candidate_id}-dev.jsonl"
        _write_eval_artifact(artifact, records, candidate.candidate_id, hashes)
        selection.append(
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
        selection,
        key=lambda row: (
            -row["dev_mean"],
            row["sampled_tokens"] + row["prompt_tokens"],
            row["iteration"],
        ),
    )[0]
    non_empty = [row for row in selection if row["suffix"]]
    best_non_empty = (
        sorted(
            non_empty,
            key=lambda row: (
                -row["dev_mean"],
                row["sampled_tokens"] + row["prompt_tokens"],
                row["iteration"],
            ),
        )[0]
        if non_empty
        else None
    )
    (ARTIFACTS / "gepa-v3-prompt.txt").write_text(winner["suffix"], encoding="utf-8")
    summary = {
        "winner": winner,
        "best_non_empty": best_non_empty,
        "candidates": selection,
        "total_rollouts": cumulative_rollouts,
        "total_sampled_tokens": cumulative_sampled,
        "total_prompt_tokens": cumulative_prompt,
        "reflection_input_tokens": reflection_input,
        "reflection_output_tokens": reflection_output,
        "reflection_model": args.reflection_model,
        "environment_surface_audit": surface_audit,
        "split": "train/dev only",
        "holdout_touched": False,
    }
    (ARTIFACTS / "gepa-v3-selection.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
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
