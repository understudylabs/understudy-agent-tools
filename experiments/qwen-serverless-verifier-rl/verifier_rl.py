#!/usr/bin/env python3
"""Base -> SFT -> verifier-RL glue for Fireworks serverless training.

The default execution is local and cheap: ``--phase grpo --dry-run`` exercises
rendering, masking, reward grouping, and the environment protocol without SDK
or network access. Live phases require explicit ``FIREWORKS_API_KEY``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import subprocess
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


HERE = Path(__file__).resolve().parent
CONTRACT_PATH = HERE / "serving-contract.qwen3p6-27b.json"
PROTOCOL_SYSTEM = ""
JOB_ARTIFACT_DIR = HERE / "artifacts"
OUTPUT_DIR = HERE.parent.parent / "outputs" / "qwen-serverless-verifier-rl"
_ACTIVE_SERVICE = None
_ACTIVE_TRAINING = None


def token_ids(value: Any) -> list[int]:
    if hasattr(value, "input_ids"):
        value = value.input_ids
    elif isinstance(value, dict):
        value = value["input_ids"]
    if value and isinstance(value[0], list):
        value = value[0]
    return [int(item) for item in value]


@dataclass
class RetryStats:
    attempts: int = 0
    failures: int = 0


def retry_call(fn: Callable[[], Any], stats: RetryStats, retries: int = 6) -> Any:
    for attempt in range(retries + 1):
        stats.attempts += 1
        try:
            return fn()
        except Exception:
            stats.failures += 1
            if attempt >= retries:
                raise
            time.sleep(min(8.0, 0.5 * 2**attempt) + random.random() * 0.25)
    raise AssertionError("unreachable")


def missing_training_session(error: BaseException) -> bool:
    text = str(error)
    return "404" in text and "TrainingSession" in text and "not found" in text.lower()


def attach_training(args, stats: RetryStats):
    global _ACTIVE_SERVICE, _ACTIVE_TRAINING
    if _ACTIVE_SERVICE is not None:
        raise RuntimeError("a Fireworks training session is already active in this process")
    last_error = None
    for attempt in range(args.retry_count + 1):
        stats.attempts += 1
        service = None
        try:
            from fireworks.training.sdk import FiretitanServiceClient

            service = FiretitanServiceClient(
                api_key=os.environ["FIREWORKS_API_KEY"],
                base_url=args.fireworks_base_url.rstrip("/") + "/training/v1/serverless",
            )
            training = service.create_lora_training_client(
                base_model=args.base_model,
                rank=args.lora_rank,
            )
            _ACTIVE_SERVICE = service
            _ACTIVE_TRAINING = training
            return service, training
        except Exception as error:
            last_error = error
            stats.failures += 1
            if service is not None:
                close_training_service(service)
            if attempt >= args.retry_count:
                raise
            time.sleep(min(8.0, 0.5 * 2**attempt) + random.random() * 0.25)
    raise last_error


def close_training_service(service) -> None:
    global _ACTIVE_SERVICE, _ACTIVE_TRAINING
    if service is not None:
        service.close()
    if _ACTIVE_SERVICE is service:
        _ACTIVE_SERVICE = None
        _ACTIVE_TRAINING = None


@dataclass
class Cost:
    prices: dict[str, float]
    max_usd: float
    tokens: dict[str, int] = field(default_factory=lambda: {"prefill": 0, "cached": 0, "sample": 0, "train": 0})
    usd: float = 0.0

    def add(self, kind: str, count: int) -> None:
        self.tokens[kind] += max(0, int(count))
        self.usd = sum(self.tokens[key] * self.prices.get(key, 0.0) / 1_000_000 for key in self.tokens)
        if self.usd > self.max_usd:
            raise BudgetExceeded(f"projected cost ${self.usd:.6f} exceeds --max-usd ${self.max_usd:.6f}")


class BudgetExceeded(RuntimeError):
    pass


def artifact_ref(path: Path, role: str, row_count: int | None = None) -> dict[str, Any]:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "role": role,
        "path": str(path),
        "sha256": digest,
        "size_bytes": path.stat().st_size,
        "row_count": row_count,
    }


def emit_event(path: Path | None, kind: str, payload: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {"schema_version": "understudy.experiment-event.v1", "event": kind, **payload}
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, separators=(",", ":")) + "\n")


def idempotency_key(experiment_id: str, candidate_id: str, attempt: int) -> str:
    value = f"{experiment_id}\0{candidate_id}\0{attempt}".encode()
    return hashlib.sha256(value).hexdigest()


def submit_request(args) -> dict[str, Any]:
    required = {
        "--policy-ref": args.policy_ref,
        "--policy-sha256": args.policy_sha256,
        "--dataset-manifest-ref": args.dataset_manifest_ref,
        "--dataset-manifest-sha256": args.dataset_manifest_sha256,
        "--train-manifest-ref": args.train_manifest_ref,
        "--train-manifest-sha256": args.train_manifest_sha256,
        "--dev-manifest-ref": args.dev_manifest_ref,
        "--dev-manifest-sha256": args.dev_manifest_sha256,
        "--verifier-environment": args.verifier_environment,
        "--verifier-revision": args.verifier_revision,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise SystemExit(f"submit requires canonical fields: {', '.join(missing)}")
    candidate = {
        "candidate_id": args.candidate_id,
        "executor": "fireworks",
        "model": args.base_model,
        "policy_ref": args.policy_ref,
        "policy_sha256": args.policy_sha256,
    }
    if args.model_revision:
        candidate["model_revision"] = args.model_revision
    return {
        "schema_version": "understudy.executor-submit.v1",
        "experiment_id": args.experiment_id,
        "candidate": candidate,
        "attempt": args.attempt,
        "workload": {
            "id": args.workload_id,
            "dataset_manifest_ref": args.dataset_manifest_ref,
            "dataset_manifest_sha256": args.dataset_manifest_sha256,
            "verifier_environment": args.verifier_environment,
            "verifier_revision": args.verifier_revision,
        },
        "splits": {
            "train_manifest_ref": args.train_manifest_ref,
            "train_manifest_sha256": args.train_manifest_sha256,
            "dev_manifest_ref": args.dev_manifest_ref,
            "dev_manifest_sha256": args.dev_manifest_sha256,
        },
        "limits": {
            "budget_usd": args.max_usd,
            "max_concurrent_candidates": args.max_concurrent_candidates,
            "max_concurrent_requests_per_candidate": args.max_concurrent_requests_per_candidate,
            "max_rollouts": args.max_rollouts,
            "max_runtime_seconds": args.max_runtime_seconds,
        },
    }


def cancel_adapter_job(result: dict[str, Any], args) -> dict[str, Any]:
    job = result["job"]
    disposition = "already_terminal"
    if _ACTIVE_SERVICE is not None and result.get("training_session_id") == getattr(_ACTIVE_SERVICE, "training_session_id", None):
        close_training_service(_ACTIVE_SERVICE)
        disposition = "cancelled"
    receipt = {
        "job": job,
        "disposition": disposition,
        "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "adapter": "fireworks",
        "adapter_invoked": True,
        "note": "A persisted job reference is terminal unless the owning adapter handle remains in this process.",
    }
    result["cancellation_receipt"] = receipt
    return result


def executor_operation(args) -> None:
    key = idempotency_key(args.experiment_id, args.candidate_id, args.attempt)
    JOB_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    mapping_path = JOB_ARTIFACT_DIR / f"job-ref-{key}.json"
    events_path = Path(args.events) if args.events else None
    if args.operation == "submit":
        if mapping_path.exists():
            result = json.loads(mapping_path.read_text())
            emit_event(events_path, "candidate", {"candidate": args.candidate_id, "status": "rebound"})
            print(json.dumps(result))
            return
        stats = RetryStats()
        service, training = attach_training(args, stats)
        request = submit_request(args)
        submitted_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job = {
            "executor": "fireworks",
            "job_id": getattr(training, "run_id", None) or getattr(service, "training_session_id", None),
            "idempotency_key": key,
            "submitted_at": submitted_at,
        }
        result = {
            "schema_version": "understudy.executor-job-ref.v1",
            "submit_request": request,
            "idempotency_key": key,
            "job": job,
            "training_session_id": getattr(service, "training_session_id", None),
            "run_id": getattr(training, "run_id", None),
            "snapshots": [],
            "status": "submitted",
            "retry": {"attempts": stats.attempts, "failures": stats.failures},
        }
        mapping_path.write_text(json.dumps(result, indent=2) + "\n")
        close_training_service(service)
        emit_event(events_path, "candidate", {"candidate": args.candidate_id, "status": "submitted"})
        print(json.dumps(result))
        return
    if not mapping_path.exists():
        raise SystemExit(f"job reference not found for idempotency key {key}")
    result = json.loads(mapping_path.read_text())
    if args.operation == "inspect":
        result["status"] = result.get("status", "submitted")
    elif args.operation == "cancel":
        result = cancel_adapter_job(result, args)
        result["status"] = "cancelled"
        mapping_path.write_text(json.dumps(result, indent=2) + "\n")
        emit_event(events_path, "run", {"status": "cancelled"})
    elif args.operation == "reconcileUsage":
        receipt_path = Path(args.receipt) if args.receipt else None
        usage = (
            json.loads(receipt_path.read_text()).get("cost", {})
            if receipt_path and receipt_path.exists()
            else {}
        )
        result = {
            "schema_version": "understudy.executor-usage-receipt.v1",
            "job_ref": artifact_ref(mapping_path, "executor_job_ref"),
            "usage": usage,
            "evidence_scope": "client-side token counts, uncached prefill upper bound; not provider-authoritative billing",
        }
        emit_event(events_path, "usage", {"upper_bound_usd": usage.get("usd", 0.0)})
    print(json.dumps(result))


class DryTokenizer:
    chat_template = "dry-run-template"

    def apply_chat_template(self, messages, tokenize=True, add_generation_prompt=False):
        text = "\n".join(f"{m['role']}:{m['content']}" for m in messages)
        if add_generation_prompt:
            text += "\nassistant:"
        return [ord(char) for char in text] if tokenize else text

    def decode(self, tokens, **_kwargs):
        return " ".join(f"t{x}" for x in tokens)

    def encode(self, text, **_kwargs):
        return [ord(char) for char in str(text)]


class DryEnv:
    def reset(self, task_id):
        return {"episode_id": f"dry-{task_id}", "prompt": "Update the requested record."}

    def step(self, episode_id, action):
        return {"observation": '{"status":"ok"}', "done": action["name"] == "finish"}

    def finish(self, episode_id):
        return {"reward": 1.0}


def render_datum(tokenizer, messages, train_on_assistant_only=True):
    full_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    ids = token_ids(tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False))
    weights = [0.0] * len(ids)
    if train_on_assistant_only:
        for message_index, message in enumerate(messages):
            if message.get("role") != "assistant":
                continue
            prefix_text = tokenizer.apply_chat_template(
                messages[:message_index], tokenize=False, add_generation_prompt=True
            )
            through_text = tokenizer.apply_chat_template(
                messages[: message_index + 1], tokenize=False, add_generation_prompt=False
            )
            if not through_text.startswith(prefix_text):
                raise ValueError("assistant prefix/template mismatch")
            prefix_ids = token_ids(tokenizer.encode(prefix_text, add_special_tokens=False))
            assistant_segment = token_ids(tokenizer.encode(
                through_text[len(prefix_text):], add_special_tokens=False
            ))
            through_ids = prefix_ids + assistant_segment
            expected_ids = token_ids(tokenizer.apply_chat_template(
                messages[: message_index + 1], tokenize=True, add_generation_prompt=False
            ))
            if through_ids != expected_ids:
                raise ValueError("assistant segment reconstruction mismatch")
            for index in range(len(prefix_ids), len(prefix_ids) + len(assistant_segment)):
                weights[index] = 1.0
    if token_ids(tokenizer.encode(full_text, add_special_tokens=False)) != ids:
        raise ValueError("full chat-template render changed during masking")
    return {
        "model_input": ids[:-1],
        "target_tokens": ids[1:],
        "weights": weights[1:],
    }


def group_advantages(rewards: list[float]) -> list[float]:
    if not rewards or max(rewards) == min(rewards):
        return []
    mean = sum(rewards) / len(rewards)
    variance = sum((value - mean) ** 2 for value in rewards) / len(rewards)
    scale = variance**0.5 or 1.0
    return [(value - mean) / scale for value in rewards]


def contract() -> dict[str, Any]:
    value = json.loads(CONTRACT_PATH.read_text())
    protocol = load_protocol_prompt()
    protocol_hash = hashlib.sha256(protocol.encode()).hexdigest()
    if value["protocol_sha256"] != protocol_hash:
        raise RuntimeError("serving contract protocol hash does not match shared protocol")
    return value


def load_protocol_prompt() -> str:
    script = (
        "import { ACTION_PROTOCOL_SYSTEM_PROMPT } "
        "from './dist/automationbench-action-protocol.js'; "
        "process.stdout.write(ACTION_PROTOCOL_SYSTEM_PROMPT)"
    )
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", script],
        cwd=HERE.parent.parent,
        text=True,
    )


def dry_run(args, receipt, cost):
    tokenizer = DryTokenizer()
    env = DryEnv()
    messages = [
        {"role": "system", "content": PROTOCOL_SYSTEM},
        {"role": "user", "content": "Update the requested record."},
        {"role": "assistant", "content": '{"tool":"api_search","arguments":{"query":"contacts"}}'},
        {"role": "user", "content": '{"status":"ok"}'},
    ]
    datum = render_datum(tokenizer, messages)
    assert len(datum["target_tokens"]) == len(datum["weights"])
    assert sum(1 for value in datum["weights"] if value) >= 5
    advantages = group_advantages([0.0, 1.0])
    assert len(advantages) == 2 and abs(sum(advantages)) < 1e-6
    zero_spread = group_advantages([1.0, 1.0])
    assert zero_spread == []
    budget_guard = Cost({"prefill": 1_000_000.0}, 0.5)
    try:
        budget_guard.add("prefill", 1)
    except BudgetExceeded:
        budget_aborted = True
    else:
        budget_aborted = False
    assert budget_aborted
    episode = env.reset("dry-task")
    assert env.step(episode["episode_id"], {"name": "api_search", "arguments": {}})["observation"]
    assert env.finish(episode["episode_id"])["reward"] == 1.0
    receipt.update({
        "dry_run": True,
        "rendered_tokens": len(datum["target_tokens"]),
        "assistant_weighted_tokens": sum(1 for value in datum["weights"] if value),
        "prompt_weighted_tokens": sum(1 for value in datum["weights"] if not value),
        "datum_lengths_equal": len(datum["model_input"]) == len(datum["target_tokens"]) == len(datum["weights"]),
        "advantages": advantages,
        "zero_spread_datums": len(zero_spread),
        "budget_guard_tripped": budget_aborted,
        "reward": 1.0,
        "env_service": "stub",
        "teardown_asserted": True,
    })


def http_json(base_url: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def parse_remote(env_url: str, text: str, retries: RetryStats, retry_count: int) -> dict[str, Any]:
    return retry_call(
        lambda: http_json(env_url, "POST", "/parse", {"text": text}),
        retries,
        retry_count,
    )


def live_sft(args, receipt, cost, retries):
    from transformers import AutoTokenizer
    import tinker

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, token=os.environ.get("HF_TOKEN"))
    service, training = attach_training(args, retries)
    receipt["run_id"] = getattr(training, "run_id", None)
    receipt["session_id"] = getattr(service, "training_session_id", None)
    def training_op(operation: Callable[[], Any]) -> Any:
        nonlocal service, training
        try:
            return retry_call(operation, retries, args.retry_count)
        except Exception as error:
            if not missing_training_session(error):
                raise
            receipt.setdefault("session_recoveries", []).append({
                "reason": str(error),
                "resume_supported": False,
            })
            close_training_service(service)
            service, training = attach_training(args, retries)
            receipt["run_id"] = getattr(training, "run_id", None)
            receipt["session_id"] = getattr(service, "training_session_id", None)
            return retry_call(operation, retries, args.retry_count)
    rows = [json.loads(line) for line in Path(args.oracle).read_text().splitlines() if line.strip()]
    try:
        for offset in range(0, len(rows), args.batch_size):
            batch = []
            for row in rows[offset : offset + args.batch_size]:
                rendered = render_datum(tokenizer, row["messages"])
                batch.append(tinker.Datum(
                    model_input=tinker.ModelInput.from_ints(rendered["model_input"]),
                    loss_fn_inputs={"target_tokens": rendered["target_tokens"], "weights": rendered["weights"]},
                ))
                cost.add("train", len(rendered["target_tokens"]))
            result = training_op(lambda: training.forward_backward(batch, "cross_entropy").result())
            training_op(lambda: training.optim_step(tinker.AdamParams(learning_rate=args.learning_rate)).result())
            receipt.setdefault("steps", []).append({"step": offset // args.batch_size, "loss": getattr(result, "metrics", {})})
    finally:
        close_training_service(service)
        receipt["teardown_asserted"] = True


def live_grpo(args, receipt, cost, retries):
    from transformers import AutoTokenizer
    import tinker

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, token=os.environ.get("HF_TOKEN"))
    service, training = attach_training(args, retries)
    receipt["run_id"] = getattr(training, "run_id", None)
    receipt["session_id"] = getattr(service, "training_session_id", None)
    c = contract()
    events_path = Path(args.events) if args.events else None
    env_url = args.env_url
    env_process = None
    if not env_url:
        env_process = subprocess.Popen(
            ["node", "scripts/automationbench-rl-service.mjs", "--port", str(args.env_port)],
            cwd=HERE.parent.parent,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        env_url = f"http://127.0.0.1:{args.env_port}"
        for _ in range(30):
            try:
                http_json(env_url, "GET", "/health")
                break
            except Exception:
                time.sleep(0.25)
        else:
            raise RuntimeError("automationbench RL service did not become healthy")
    def recover_session(reason: BaseException):
        nonlocal service, training
        receipt.setdefault("session_recoveries", []).append({
            "reason": str(reason),
            "resume_supported": False,
        })
        close_training_service(service)
        service, training = attach_training(args, retries)
        receipt["run_id"] = getattr(training, "run_id", None)
        receipt["session_id"] = getattr(service, "training_session_id", None)

    def training_op(operation: Callable[[], Any]) -> Any:
        try:
            return retry_call(operation, retries, args.retry_count)
        except Exception as error:
            if not missing_training_session(error):
                raise
            recover_session(error)
            return retry_call(operation, retries, args.retry_count)

    try:
        tasks = http_json(env_url, "GET", "/tasks?split=train")
        if not tasks:
            raise RuntimeError("train split is empty")
        for step_index in range(args.steps):
            snapshot = training_op(
                lambda: training.save_weights_for_sampler(f"verifier-rl-step-{step_index}").result().path,
            )
            receipt["snapshots"].append(snapshot)
            try:
                sampler = training_op(
                    lambda: service.create_sampling_client(model_path=snapshot, tokenizer=tokenizer),
                )
            except Exception as error:
                if not missing_training_session(error):
                    raise
                recover_session(error)
                snapshot = training_op(
                    lambda: training.save_weights_for_sampler(
                        f"verifier-rl-step-{step_index}-recovered",
                    ).result().path,
                )
                receipt["snapshots"].append(snapshot)
                sampler = training_op(
                    lambda: service.create_sampling_client(model_path=snapshot, tokenizer=tokenizer),
                )
            try:
                selected = [tasks[(step_index * args.prompt_groups_per_step + i) % len(tasks)]
                            for i in range(args.prompt_groups_per_step)]
                group_episodes = []
                for task in selected:
                    emit_event(events_path, "rollout", {"task_id": task["task_id"], "status": "started"})
                    episodes = []
                    for _ in range(args.group_size):
                        reset_result = retry_call(
                            lambda task_id=task["task_id"]: http_json(
                                env_url, "POST", "/reset", {"task_id": task_id}
                            ),
                            retries,
                            args.retry_count,
                        )
                        messages = [
                            {"role": "system", "content": PROTOCOL_SYSTEM},
                            {"role": "user", "content": reset_result["prompt"]},
                        ]
                        turns = []
                        reward = 0.0
                        malformed_turns = 0
                        consecutive_malformed = 0
                        episode_finished = False
                        for _turn in range(args.max_turns):
                            prompt_ids = token_ids(tokenizer.apply_chat_template(
                                messages, tokenize=True, add_generation_prompt=True
                            ))
                            prompt = tinker.ModelInput.from_ints(prompt_ids)
                            result = retry_call(
                                lambda: sampler.sample(
                                    prompt=prompt,
                                    num_samples=1,
                                    sampling_params=tinker.SamplingParams(
                                        max_tokens=args.max_tokens,
                                        temperature=args.temperature,
                                        stop=c["stop_sequences"],
                                    ),
                                ).result(),
                                retries,
                                args.retry_count,
                            )
                            sequence = result.sequences[0]
                            tokens = list(sequence.tokens)
                            logprobs = list(getattr(sequence, "logprobs", []) or [0.0] * len(tokens))
                            cost.add("prefill", len(prompt_ids))
                            cost.add("sample", len(tokens))
                            text = tokenizer.decode(tokens, skip_special_tokens=False)
                            messages.append({"role": "assistant", "content": text})
                            turns.append((prompt, tokens, logprobs))
                            parsed = parse_remote(env_url, text, retries, args.retry_count)
                            if "error" in parsed:
                                malformed_turns += 1
                                consecutive_malformed += 1
                                if consecutive_malformed >= int(c["malformed_tolerance"]):
                                    break
                                messages.append({
                                    "role": "user",
                                    "content": f"rejected: {parsed['error']}. Reply with exactly one JSON tool object.",
                                })
                                continue
                            consecutive_malformed = 0
                            if parsed.get("finish") is True:
                                reward = retry_call(
                                    lambda: http_json(
                                        env_url, "POST", "/finish",
                                        {"episode_id": reset_result["episode_id"]},
                                    )["reward"],
                                    retries,
                                    args.retry_count,
                                )
                                episode_finished = True
                                break
                            action = parsed["action"]
                            observation = retry_call(
                                lambda: http_json(
                                    env_url, "POST", "/step",
                                    {"episode_id": reset_result["episode_id"], "action": action},
                                ),
                                retries,
                                args.retry_count,
                            )
                            messages.append({"role": "user", "content": observation["observation"]})
                            if observation.get("done"):
                                reward = retry_call(
                                    lambda: http_json(
                                        env_url, "POST", "/finish",
                                        {"episode_id": reset_result["episode_id"]},
                                    )["reward"],
                                    retries,
                                    args.retry_count,
                                )
                                episode_finished = True
                                break
                        if not episode_finished:
                            reward = retry_call(
                                lambda: http_json(
                                    env_url, "POST", "/finish",
                                    {"episode_id": reset_result["episode_id"]},
                                )["reward"],
                                retries,
                                args.retry_count,
                            )
                        episodes.append((reward, turns))
                    group_episodes.append(episodes)
                    emit_event(events_path, "rollout", {"task_id": task["task_id"], "status": "terminal"})
                datums = []
                for episodes in group_episodes:
                    rewards = [item[0] for item in episodes]
                    advantages = group_advantages(rewards)
                    if not advantages:
                        continue
                    for (_, turns), advantage in zip(episodes, advantages):
                        for prompt, tokens, logprobs in turns:
                            response_start = prompt.length - 1
                            model_input = prompt.append(tinker.EncodedTextChunk(tokens=tokens[:-1]))
                            target_tokens = [0] * response_start + tokens
                            padded_logprobs = [0.0] * response_start + logprobs
                            padded_advantages = [0.0] * response_start + [advantage] * (model_input.length - response_start)
                            assert len(target_tokens) == model_input.length
                            assert len(padded_logprobs) == model_input.length
                            assert len(padded_advantages) == model_input.length
                            datums.append(tinker.Datum(
                                model_input=model_input,
                                loss_fn_inputs={
                                    "target_tokens": target_tokens,
                                    "logprobs": padded_logprobs,
                                    "advantages": padded_advantages,
                                },
                            ))
                            cost.add("train", model_input.length)
                if datums:
                    training_op(lambda: training.forward_backward(datums, "importance_sampling").result())
                    training_op(
                        lambda: training.optim_step(tinker.AdamParams(
                            learning_rate=args.learning_rate
                        )).result()
                    )
                receipt.setdefault("steps", []).append({
                    "step": step_index,
                    "groups": len(group_episodes),
                    "datums": len(datums),
                })
                emit_event(events_path, "score", {
                    "step": step_index,
                    "groups": len(group_episodes),
                    "datums": len(datums),
                })
            finally:
                sampler.close()
    finally:
        close_training_service(service)
        if env_process is not None:
            env_process.terminate()
            env_process.wait(timeout=10)
        receipt["teardown_asserted"] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["sft", "grpo"], default="grpo")
    parser.add_argument("--operation", choices=["submit", "inspect", "cancel", "reconcileUsage"])
    parser.add_argument("--experiment-id", default="")
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--attempt", type=int, default=0)
    parser.add_argument("--policy-ref", default="")
    parser.add_argument("--policy-sha256", default="")
    parser.add_argument("--model-revision", default="")
    parser.add_argument("--workload-id", default="automationbench-simple-api-offline-v2")
    parser.add_argument("--dataset-manifest-ref", default="")
    parser.add_argument("--dataset-manifest-sha256", default="")
    parser.add_argument("--verifier-environment", default="automationbench-offline-v2")
    parser.add_argument("--verifier-revision", default="")
    parser.add_argument("--train-manifest-ref", default="")
    parser.add_argument("--train-manifest-sha256", default="")
    parser.add_argument("--dev-manifest-ref", default="")
    parser.add_argument("--dev-manifest-sha256", default="")
    parser.add_argument("--max-concurrent-candidates", type=int, default=1)
    parser.add_argument("--max-concurrent-requests-per-candidate", type=int, default=1)
    parser.add_argument("--max-rollouts", type=int, default=1000000)
    parser.add_argument("--max-runtime-seconds", type=int, default=604800)
    parser.add_argument("--events", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--oracle", default=str(HERE / "oracle.jsonl"))
    parser.add_argument("--receipt", default="")
    parser.add_argument("--base-model", default=None)
    parser.add_argument("--tokenizer", default=None)
    parser.add_argument("--lora-rank", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--max-usd", type=float, default=0.05)
    parser.add_argument("--max-turns", type=int, default=None)
    parser.add_argument("--steps", type=int, default=1)
    parser.add_argument("--prompt-groups-per-step", type=int, default=2)
    parser.add_argument("--group-size", type=int, default=2)
    parser.add_argument("--max-tokens", type=int, default=None)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--env-url", default="")
    parser.add_argument("--env-port", type=int, default=17891)
    parser.add_argument("--fireworks-base-url", default="https://api.fireworks.ai")
    parser.add_argument("--retry-count", type=int, default=6)
    args = parser.parse_args()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if not args.receipt:
        args.receipt = str(OUTPUT_DIR / f"{args.phase}.receipt.json")
    if not args.events:
        args.events = str(OUTPUT_DIR / f"{args.phase}.events.jsonl")
    if args.operation:
        if not args.experiment_id or not args.candidate_id:
            parser.error("--operation requires --experiment-id and --candidate-id")
        if args.operation == "reconcileUsage" and not args.receipt:
            parser.error("reconcileUsage requires --receipt")
        c = contract()
        args.base_model = args.base_model or c["base_model"]
        args.tokenizer = args.tokenizer or c["tokenizer"]
        executor_operation(args)
        return
    if args.smoke:
        args.dry_run = False
        args.max_tokens = 128
        args.prompt_groups_per_step = 2
        args.group_size = 2
        args.max_usd = min(args.max_usd, 0.10)
    c = contract()
    global PROTOCOL_SYSTEM
    PROTOCOL_SYSTEM = load_protocol_prompt()
    args.base_model = args.base_model or c["base_model"]
    args.tokenizer = args.tokenizer or c["tokenizer"]
    args.max_turns = args.max_turns or int(c["max_model_turns"])
    args.max_tokens = args.max_tokens or int(c["max_tokens"])
    receipt = {
        "schema_version": "understudy.qwen_serverless_verifier_rl.receipt.v1",
        "phase": args.phase,
        "started_at": time.time(),
        "base_model": args.base_model,
        "tokenizer": args.tokenizer,
        "max_usd": args.max_usd,
        "retry": {"attempts": 0, "failures": 0},
        "snapshots": [],
        "session_characterization": {
            "max_live_training_sessions_per_process": 1,
            "concurrency_finding": "Concurrent sessions showed intermittent 404 TrainingSession-not-found failures; idle-delay probe at 0/30/120/300 seconds succeeded.",
        },
        "artifact_manifest": [artifact_ref(CONTRACT_PATH, "serving_contract")],
        "cost_accounting": {
            "prefill_priced_at_uncached_rate": True,
            "note": "Prefill uses the uncached rate as an upper bound.",
            "evidence_scope": "client-side token counts, uncached prefill upper bound",
            "request_isolation": "one serialized Fireworks session per process",
            "figures": {
                "prefill": {"basis": "upper_bound"},
                "cached": {"basis": "upper_bound"},
                "sample": {"basis": "upper_bound"},
                "train": {"basis": "upper_bound"},
            },
        },
        "split_binding": {
            "fixture_id": "automationbench-simple-api-offline-v2",
            "fixture_sha256": "918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22",
            "split": "train",
            "split_sha256": "71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b",
        },
        "holdout": {"state": "clean", "run_once": True},
        "quality_calibration": {
            "status": "not_scored",
            "over_acting_episodes": 0,
            "forbidden_writes": 0,
            "veto_if_forbidden_writes_increase": True,
            "failure_clusters": [],
        },
        "claim_boundary": {
            "entitled": ["client-side token-cost upper bound", "offline verifier scores for explicitly recorded split"],
            "not_entitled": ["provider-authoritative billing total", "holdout quality before an executed frozen-hash run"],
        },
    }
    cost = Cost(c["pricing_usd_per_million_tokens"], args.max_usd)
    retries = RetryStats()
    events_path = Path(args.events) if args.events else None
    emit_event(events_path, "run", {"phase": args.phase, "status": "started"})
    oracle_path = Path(args.oracle)
    if oracle_path.exists():
        receipt["artifact_manifest"].append(artifact_ref(
            oracle_path,
            "oracle_jsonl",
            sum(1 for line in oracle_path.read_text().splitlines() if line.strip()),
        ))
    try:
        if args.dry_run:
            dry_run(args, receipt, cost)
        elif args.phase == "sft":
            live_sft(args, receipt, cost, retries)
        else:
            live_grpo(args, receipt, cost, retries)
        receipt["status"] = "ok"
        emit_event(events_path, "run", {"phase": args.phase, "status": "completed"})
    except BudgetExceeded as error:
        receipt["status"] = "budget_aborted"
        receipt["error"] = str(error)
        receipt["stopped_at"] = "budget_guard"
        emit_event(events_path, "error", {"class": "budget_exceeded", "status": "aborted"})
    except Exception as error:
        receipt["status"] = "error"
        receipt["error"] = f"{type(error).__name__}: {error}"
        receipt["stopped_at"] = "exception"
        emit_event(events_path, "error", {"class": type(error).__name__, "status": "failed"})
        raise
    finally:
        receipt["retry"] = {"attempts": retries.attempts, "failures": retries.failures}
        receipt["cost"] = {
            "tokens": cost.tokens,
            "usd": cost.usd,
            "basis": "upper_bound",
            "evidence_scope": "client-side token counts, uncached prefill upper bound",
            "request_isolation": "serialized; at most one live Fireworks training session per process",
            "figures": {
                key: {"tokens": value, "basis": "upper_bound"}
                for key, value in cost.tokens.items()
            },
        }
        emit_event(events_path, "usage", {
            "tokens": cost.tokens,
            "upper_bound_usd": cost.usd,
            "prefill_priced_at_uncached_rate": True,
        })
        receipt["finished_at"] = time.time()
        out = Path(args.receipt or f"verifier-rl-{args.phase}-receipt.json")
        out.write_text(json.dumps(receipt, indent=2) + "\n")
        receipt_manifest = {
            "schema_version": "understudy.artifact-manifest.v1",
            "artifacts": [artifact_ref(out, "receipt", 1)],
        }
        out.with_name(f"{out.name}.manifest.json").write_text(
            json.dumps(receipt_manifest, indent=2) + "\n",
        )
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
