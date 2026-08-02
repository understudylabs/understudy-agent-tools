"""Conservative v4 GEPA: short, single-rule suffixes only."""

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
from gepa_optimize_v3 import _public_surface

REPO = Path(__file__).resolve().parents[2]
MINIBATCH_SIZE = 8
REFLECTION_MAX_TOKENS = 600


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=MAX_ITERATIONS)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--reflection-model", default="claude-sonnet-4-6")
    parser.add_argument("--full-rewrite", action="store_true")
    return parser.parse_args()


def _feedback(records: list[dict[str, Any]], tasks: dict[str, Any], protocol: dict[str, Any]) -> list[dict[str, Any]]:
    failures = [record for record in records if record["reward"] < 1.0]
    surface = _public_surface(protocol, failures)
    return [
        {
            "task_id": record["task_id"],
            "task_prompt": tasks[record["task_id"]]["prompt"],
            "score": record["reward"],
            "diagnostics": _diagnostics(record),
            "actions": _action_sequence(record),
            "observed_tool_responses": surface["observed_tool_responses"][record["task_id"]],
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
    baseline_prompt: str | None = None,
) -> tuple[str, str, int, int]:
    system = """You are a conservative prompt-reflection engine.
The frozen protocol prompt is already complete. Propose ONE general behavioral
rule as a suffix of at most 40 words. Target one dominant failure mode only.
Use only endpoint paths, methods, and fields appearing verbatim in the supplied
catalog or observed responses; never invent API details or hardcode task data.
The rule must generalize across families. No grader internals are supplied:
never request or infer assertions, gold values, allowedWrites, oracle actions,
or expected final state. Return only the suffix text."""
    if baseline_prompt is not None:
        system = """Rewrite the complete system prompt conservatively.
Preserve the supplied baseline protocol text verbatim, including its JSON
action rules. Add at most one general behavioral rule of 40 words or fewer.
Use only endpoint paths, methods, and fields appearing in the supplied catalog
or observed responses. Never invent API details, hardcode task data, or mention
grader internals. Return the complete prompt only."""
    user = json.dumps({
        "iteration": iteration,
        "parent_prompt": parent.suffix,
        "baseline_protocol": baseline_prompt,
        "failure_cases": feedback,
    }, indent=2)
    for _ in range(2):
        text, stop_reason, input_tokens, output_tokens = await asyncio.to_thread(
            _anthropic_request, model, system, user
        )
        if stop_reason not in {"length", "max_tokens"}:
            proposal = text.strip()
            if baseline_prompt is None:
                proposal = " ".join(proposal.split()[:40])
            elif not proposal.startswith(baseline_prompt):
                raise RuntimeError("full prompt proposal did not preserve baseline protocol verbatim")
            return proposal, stop_reason, input_tokens, output_tokens
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
    client = tinker.ServiceClient()
    sampling = await client.create_sampling_client_async(base_model=MODEL_NAME)
    baseline = Candidate(
        candidate_id="empty",
        suffix="",
        iteration=0,
        train_scores={r["task_id"]: r["reward"] for r in baseline_records},
        sampled_tokens=sum(sum(r["sampled_token_counts"]) for r in baseline_records),
        prompt_tokens=sum(sum(r["prompt_token_counts"]) for r in baseline_records),
        rollouts=len(baseline_records),
        metadata={"records": baseline_records},
    )
    pool = [baseline]
    prefix = "gepa-v4-full" if args.full_rewrite else "gepa-v4"
    log_path = ARTIFACTS / f"{prefix}-log.jsonl"
    candidates_path = ARTIFACTS / f"{prefix}-candidates.jsonl"
    env_path = ARTIFACTS / f"{prefix}-environment.json"
    log_path.write_text("", encoding="utf-8")
    candidates_path.write_text("", encoding="utf-8")
    cumulative_rollouts = baseline.rollouts
    cumulative_sampled = baseline.sampled_tokens
    cumulative_prompt = baseline.prompt_tokens
    reflection_input = reflection_output = 0
    for iteration in range(1, args.iterations + 1):
        eligible = [
            candidate for candidate in pool
            if any(
                candidate.train_scores[t["task_id"]]
                >= max(other.train_scores[t["task_id"]] for other in pool)
                for t in tasks
            )
        ]
        parent = rng.choice(eligible or [max(pool, key=lambda item: item.train_mean)])
        minibatch = _choose_failure_batch(parent, tasks, rng)
        if not minibatch:
            event = {
                "iteration": iteration,
                "parent_id": parent.candidate_id,
                "parent_full_train_mean": parent.train_mean,
                "status": "stopped",
                "stop_reason": f"parent {parent.candidate_id} has zero TRAIN failures",
            }
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, separators=(",", ":")) + "\n")
            print(json.dumps(event), flush=True)
            break
        if "records_by_id" in parent.metadata:
            parent_records = [parent.metadata["records_by_id"][t["task_id"]] for t in minibatch]
        else:
            by_id = {r["task_id"]: r for r in parent.metadata["records"]}
            parent_records = [by_id[t["task_id"]] for t in minibatch]
        feedback = _feedback(parent_records, task_by_id, protocol)
        if not env_path.exists():
            env_path.write_text(
                json.dumps(
                    {
                        "tool_catalog": feedback[0]["tool_catalog"],
                        "endpoint_catalog": feedback[0]["endpoint_catalog"],
                        "observed_tool_responses_by_failure": {
                            item["task_id"]: item["observed_tool_responses"] for item in feedback
                        },
                        "audit": {"evaluator_audit_observation_leakage_findings": []},
                    },
                    indent=2,
                ) + "\n",
                encoding="utf-8",
            )
        suffix, finish_reason, input_tokens, output_tokens = await _propose(
            args.reflection_model,
            parent,
            feedback,
            iteration,
            protocol["system_prompt"] if args.full_rewrite else None,
        )
        reflection_input += input_tokens
        reflection_output += output_tokens
        mb_records = await _run_rollouts(
            service,
            sampling,
            renderer,
            minibatch,
            "" if args.full_rewrite else suffix,
            args.concurrency,
            full_system_prompt=suffix if args.full_rewrite else None,
        )
        probe_records = []
        probe_parse_errors = 0
        if args.full_rewrite:
            probe_records = await _run_rollouts(
                service,
                sampling,
                renderer,
                tasks[:4],
                "",
                args.concurrency,
                full_system_prompt=suffix,
            )
            probe_parse_errors = sum(len(r.get("parse_errors", [])) for r in probe_records)
            baseline_probe_errors = sum(
                len(r.get("parse_errors", [])) for r in baseline_records[:4]
            )
            if probe_parse_errors > baseline_probe_errors:
                full_records = []
            else:
                full_records = await _run_rollouts(
                    service,
                    sampling,
                    renderer,
                    tasks,
                    "",
                    args.concurrency,
                    full_system_prompt=suffix,
                )
        else:
            full_records = await _run_rollouts(
                service, sampling, renderer, tasks, suffix, args.concurrency
            )
        mb_sampled, mb_prompt = _record_tokens(mb_records)
        probe_sampled, probe_prompt = _record_tokens(probe_records)
        full_sampled, full_prompt = _record_tokens(full_records)
        cumulative_rollouts += len(mb_records) + len(probe_records) + len(full_records)
        cumulative_sampled += mb_sampled + probe_sampled + full_sampled
        cumulative_prompt += mb_prompt + probe_prompt + full_prompt
        scores = {r["task_id"]: r["reward"] for r in full_records}
        child_mean = statistics.fmean(scores.values()) if scores else 0.0
        accepted = child_mean >= parent.train_mean
        child_id = None
        if accepted:
            child_id = f"v4-iter-{iteration}-{uuid.uuid4().hex[:8]}"
            child = Candidate(
                candidate_id=child_id,
                suffix=suffix,
                iteration=iteration,
                train_scores=scores,
                sampled_tokens=full_sampled,
                prompt_tokens=full_prompt,
                rollouts=len(full_records),
                metadata={"records_by_id": {r["task_id"]: r for r in full_records}},
            )
            pool.append(child)
            _write_eval_artifact(ARTIFACTS / f"{child_id}-train.jsonl", full_records, child_id, hashes)
            with candidates_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"candidate_id": child_id, "iteration": iteration, "suffix": suffix, "train_mean": child_mean, "train_scores": scores}, separators=(",", ":")) + "\n")
        event = {
            "iteration": iteration,
            "parent_id": parent.candidate_id,
            "parent_full_train_mean": parent.train_mean,
            "minibatch_failure_task_ids": [t["task_id"] for t in minibatch if parent.train_scores[t["task_id"]] < 1.0],
            "minibatch_task_ids": [t["task_id"] for t in minibatch],
            "child_full_train_mean": child_mean,
            "accepted": accepted,
            "child_id": child_id,
            "proposed_suffix": suffix,
            "finish_reason": finish_reason,
            "probe_parse_errors": probe_parse_errors,
            "probe_rollouts": len(probe_records),
            "cumulative_rollout_count": cumulative_rollouts,
            "cumulative_sampled_tokens": cumulative_sampled,
            "cumulative_prompt_tokens": cumulative_prompt,
            "reflection_input_tokens": input_tokens,
            "reflection_output_tokens": output_tokens,
        }
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
        print(json.dumps(event), flush=True)

    selection = [{
        "candidate_id": "empty",
        "suffix": "",
        "dev_mean": statistics.fmean(r["reward"] for r in baseline_dev_records),
        "sampled_tokens": sum(sum(r["sampled_token_counts"]) for r in baseline_dev_records),
        "prompt_tokens": sum(sum(r["prompt_token_counts"]) for r in baseline_dev_records),
        "iteration": 0,
        "artifact": str(baseline_dev_path),
    }]
    for candidate in sorted(pool[1:], key=lambda item: (-item.train_mean, item.iteration))[:3]:
        records = await _run_rollouts(
            service,
            sampling,
            renderer,
            service.tasks("dev"),
            "" if args.full_rewrite else candidate.suffix,
            args.concurrency,
            full_system_prompt=candidate.suffix if args.full_rewrite else None,
        )
        sampled, prompt = _record_tokens(records)
        cumulative_rollouts += len(records)
        cumulative_sampled += sampled
        cumulative_prompt += prompt
        artifact = ARTIFACTS / f"{candidate.candidate_id}-dev.jsonl"
        _write_eval_artifact(artifact, records, candidate.candidate_id, hashes)
        selection.append({"candidate_id": candidate.candidate_id, "suffix": candidate.suffix, "dev_mean": statistics.fmean(r["reward"] for r in records), "sampled_tokens": sampled, "prompt_tokens": prompt, "iteration": candidate.iteration, "artifact": str(artifact)})
    winner = sorted(selection, key=lambda row: (-row["dev_mean"], row["sampled_tokens"] + row["prompt_tokens"], row["iteration"]))[0]
    non_empty = [row for row in selection if row["suffix"]]
    best_non_empty = sorted(non_empty, key=lambda row: (-row["dev_mean"], row["sampled_tokens"] + row["prompt_tokens"], row["iteration"]))[0] if non_empty else None
    prompt_path = ARTIFACTS / f"{prefix}-prompt.txt"
    prompt_path.write_text(winner["suffix"], encoding="utf-8")
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
        "split": "train/dev only",
        "holdout_touched": False,
        "mode": "full-rewrite" if args.full_rewrite else "suffix",
        "prompt_artifact": str(prompt_path),
    }
    (ARTIFACTS / f"{prefix}-selection.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"winner": winner["candidate_id"], "best_non_empty": best_non_empty["candidate_id"] if best_non_empty else None, "total_rollouts": cumulative_rollouts, "total_sampled_tokens": cumulative_sampled, "total_prompt_tokens": cumulative_prompt, "reflection_input_tokens": reflection_input, "reflection_output_tokens": reflection_output}), flush=True)


def main() -> None:
    try:
        asyncio.run(_run(_args()))
    finally:
        close_service()


if __name__ == "__main__":
    main()
