"""AutomationBench multi-turn RL/evaluation driver.

The environment, rollout, renderer, and Tinker-compatible update path are
provider-neutral.  ``ServerlessBackend`` is the live Fireworks adapter and
``TinkerBackend`` is the corresponding adapter for the same protocol.

This file intentionally keeps holdout sealed.  The CLI only accepts train/dev
unless the caller supplies the frozen holdout hash explicitly.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.renderers import Message, get_text_content
from tinker_cookbook.tokenizer_utils import get_tokenizer

from env_client import EnvService

REPO = Path(__file__).resolve().parents[2]
EXPERIMENT_DIR = Path(__file__).resolve().parent
ARTIFACT_DIR = EXPERIMENT_DIR / "artifacts"
HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701"
EXPECTED_FIXTURE_SHA256 = "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f"
EXPECTED_SPLITS = {
    "train": "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89",
    "dev": "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc",
    "holdout": HOLDOUT_SHA256,
}
MAX_MODEL_TURNS = 12
DEFAULT_MAX_TOKENS = 192
RENDERERS = {
    "accounts/fireworks/models/qwen3p5-9b": ("Qwen/Qwen3.5-9B", "qwen3_5_disable_thinking"),
    "accounts/fireworks/models/qwen3p6-27b": ("Qwen/Qwen3.6-27B", "qwen3_5_disable_thinking"),
    "Qwen/Qwen3.5-9B": ("Qwen/Qwen3.5-9B", "qwen3_5_disable_thinking"),
    "Qwen/Qwen3.6-27B": ("Qwen/Qwen3.6-27B", "qwen3_5_disable_thinking"),
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16": (
        "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
        "nemotron3_disable_thinking",
    ),
    "Qwen/Qwen3-8B": ("Qwen/Qwen3-8B", "qwen3_disable_thinking"),
}
RATES_USD_PER_TOKEN = {
    "accounts/fireworks/models/qwen3p5-9b": {
        "prefill": 0.66e-6,
        "cached_prefill": 0.132e-6,
        "sample": 1.995e-6,
        "train": 1.463e-6,
    },
    "accounts/fireworks/models/qwen3p6-27b": {
        "prefill": 1.86e-6,
        "cached_prefill": 0.372e-6,
        "sample": 5.595e-6,
        "train": 4.103e-6,
    },
}


def _json_decode(value: Any) -> Any:
    while isinstance(value, str):
        value = json.loads(value)
    return value


def parse_tool_calls(text: str) -> list[dict[str, Any]]:
    """Mirror ``parseToolCalls`` while accepting a renderer's plain JSON text."""
    try:
        decoded = _json_decode(text.strip())
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    if not isinstance(decoded, dict):
        return []
    raw_calls = decoded.get("tool_calls")
    if raw_calls is None:
        raw_calls = [decoded]
    if not isinstance(raw_calls, list):
        return []
    calls: list[dict[str, Any]] = []
    for raw in raw_calls:
        try:
            record = _json_decode(raw)
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        if not isinstance(record, dict):
            return []
        function = record.get("function")
        fn = function if isinstance(function, dict) else record
        name = fn.get("name", record.get("name", record.get("tool", "")))
        arguments = fn.get("arguments", record.get("arguments", {}))
        try:
            arguments = _json_decode(arguments)
        except (TypeError, ValueError, json.JSONDecodeError):
            return []
        if not isinstance(name, str) or not name:
            return []
        if not isinstance(arguments, dict):
            return []
        calls.append({"name": name, "arguments": arguments})
    return calls


def _prompt_length(model_input: Any) -> int:
    return sum(len(getattr(chunk, "tokens", []) or []) for chunk in model_input.chunks)


def _group_advantages(rewards: list[float], eps: float = 1e-8) -> list[float]:
    if len(rewards) <= 1:
        return [0.0] * len(rewards)
    mean = sum(rewards) / len(rewards)
    variance = sum((reward - mean) ** 2 for reward in rewards) / (len(rewards) - 1)
    std = math.sqrt(variance)
    return [(reward - mean) / (std + eps) for reward in rewards]


@dataclass
class TokenMeter:
    model: str
    phase: str
    prefill_tokens: int = 0
    cached_prefill_tokens: int = 0
    sample_tokens: int = 0
    train_tokens: int = 0
    sampling_seconds: float = 0.0

    def add_sampling(
        self, prompt_tokens: int, sample_tokens: int, elapsed_seconds: float
    ) -> None:
        self.prefill_tokens += prompt_tokens
        self.sample_tokens += sample_tokens
        self.sampling_seconds += elapsed_seconds

    def add_train(self, tokens: int) -> None:
        self.train_tokens += tokens

    @property
    def usd(self) -> float:
        rates = RATES_USD_PER_TOKEN.get(self.model, {})
        return (
            self.prefill_tokens * rates.get("prefill", 0.0)
            + self.cached_prefill_tokens * rates.get("cached_prefill", 0.0)
            + self.sample_tokens * rates.get("sample", 0.0)
            + self.train_tokens * rates.get("train", 0.0)
        )

    def receipt(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "phase": self.phase,
            "prefill_tokens": self.prefill_tokens,
            "cached_prefill_tokens": self.cached_prefill_tokens,
            "sample_tokens": self.sample_tokens,
            "train_tokens": self.train_tokens,
            "sampling_seconds": self.sampling_seconds,
            "sampling_tokens_per_second": (
                self.sample_tokens / self.sampling_seconds
                if self.sampling_seconds > 0
                else 0.0
            ),
            "estimated_usd": self.usd,
        }

    def enforce_cap(self, cap: float) -> None:
        if self.usd > cap:
            raise RuntimeError(f"{self.phase} exceeded USD cap {cap:.2f}: {self.usd:.4f}")


class Backend(Protocol):
    model: str
    service: Any
    training_client: Any

    def save_weights_for_sampler(self, name: str) -> str: ...

    def create_sampling_client(self, model_path: str, tokenizer: Any) -> Any: ...

    def close(self) -> None: ...


class ServerlessBackend:
    def __init__(self, model: str, rank: int = 8, api_key: str | None = None) -> None:
        from fireworks.training.sdk import FiretitanServiceClient

        self.model = model
        self.service = FiretitanServiceClient(
            base_url="https://api.fireworks.ai/training/v1/serverless",
            api_key=api_key or os.environ["FIREWORKS_API_KEY"],
        )
        self.training_client = self.service.create_lora_training_client(
            base_model=model, rank=rank
        )

    def save_weights_for_sampler(self, name: str) -> str:
        result = self.training_client.save_weights_for_sampler(name).result()
        path = getattr(result, "path", None)
        if not path:
            raise RuntimeError(f"save_weights_for_sampler returned no path: {result!r}")
        return str(path)

    def create_sampling_client(self, model_path: str, tokenizer: Any) -> Any:
        return self.service.create_sampling_client(model_path=model_path, tokenizer=tokenizer)

    def close(self) -> None:
        session_id = self.service.training_session_id
        close = getattr(self.service, "close", None)
        try:
            if close:
                close()
        finally:
            if session_id:
                _release_serverless_session(session_id)


class TinkerBackend:
    """The same adapter shape for the direct Tinker lane."""

    def __init__(self, model: str, rank: int = 8) -> None:
        self.model = model
        self.service = tinker.ServiceClient()
        self.training_client = self.service.create_lora_training_client(
            base_model=model, rank=rank
        )

    def save_weights_for_sampler(self, name: str) -> str:
        result = self.training_client.save_weights_for_sampler(name).result()
        path = getattr(result, "path", None)
        if not path:
            raise RuntimeError(f"save_weights_for_sampler returned no path: {result!r}")
        return str(path)

    def create_sampling_client(self, model_path: str, tokenizer: Any) -> Any:
        return self.service.create_sampling_client(model_path=model_path)

    def close(self) -> None:
        close = getattr(self.service, "close", None)
        if close:
            close()


@dataclass
class Rollout:
    task_id: str
    split: str
    reward: float
    turns: list[dict[str, Any]]
    parse_errors: list[str]
    env_steps: int
    finished_explicitly: bool
    messages: list[Message]
    terminal: dict[str, Any]


def rollout(
    env: EnvService,
    sampling_client: Any,
    renderer: Any,
    task: dict[str, Any],
    meter: TokenMeter,
    temperature: float,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    tokenizer: Any | None = None,
    action_transform: Any | None = None,
    prompt_override: str | None = None,
    frozen_holdout_sha256: str | None = None,
) -> Rollout:
    reset = env.reset(task["task_id"], frozen_holdout_sha256=frozen_holdout_sha256)
    episode_id = reset["episode_id"]
    if prompt_override is not None:
        reset["prompt"] = prompt_override
    messages: list[Message] = [
        {"role": "system", "content": reset["system_prompt"]},
        {"role": "user", "content": reset["prompt"]},
    ]
    turns: list[dict[str, Any]] = []
    parse_errors: list[str] = []
    env_steps = 0
    terminal: dict[str, Any] | None = None
    finished_explicitly = False
    try:
        for _ in range(MAX_MODEL_TURNS):
            prompt = renderer.build_generation_prompt(messages)
            sample_started = time.monotonic()
            result = sampling_client.sample(
                prompt=prompt,
                num_samples=1,
                sampling_params=tinker.SamplingParams(
                    max_tokens=max_tokens,
                    temperature=temperature,
                    stop=renderer.get_stop_sequences(),
                ),
            ).result()
            sample_seconds = time.monotonic() - sample_started
            sequence = result.sequences[0]
            tokens = list(getattr(sequence, "tokens", []) or [])
            logprobs = list(getattr(sequence, "logprobs", []) or [])
            meter.add_sampling(_prompt_length(prompt), len(tokens), sample_seconds)
            assistant_message, termination = renderer.parse_response(tokens)
            text = get_text_content(assistant_message)
            messages.append({"role": "assistant", "content": text})
            calls = parse_tool_calls(text)
            parsed_action = calls[0] if len(calls) == 1 else None
            action = action_transform(parsed_action) if action_transform else parsed_action
            turn = {
                "prompt": prompt,
                "prompt_tokens": [
                    token
                    for chunk in prompt.chunks
                    for token in (getattr(chunk, "tokens", []) or [])
                ],
                "prompt_text": (
                    tokenizer.decode(
                        [
                            token
                            for chunk in prompt.chunks
                            for token in (getattr(chunk, "tokens", []) or [])
                        ],
                        skip_special_tokens=False,
                    )
                    if tokenizer is not None
                    else None
                ),
                "tokens": tokens,
                "logprobs": [float(value) for value in logprobs],
                "text": text,
                "termination": str(termination),
                "sample_seconds": sample_seconds,
                "parsed_action": parsed_action,
                "action_sent": action,
            }
            turns.append(turn)
            if action is None or action["name"] not in {"api_search", "api_fetch", "finish"}:
                error = "expected exactly one api_search, api_fetch, or finish tool call"
                parse_errors.append(error)
                messages.append(
                    {"role": "tool", "content": json.dumps({"error": error}, separators=(",", ":"))}
                )
                turn["tool_observation"] = json.dumps({"error": error}, separators=(",", ":"))
                continue
            call = action
            if call["name"] == "finish":
                terminal = env.finish(episode_id)
                finished_explicitly = True
                turn["tool_observation"] = None
                break
            step_result = env.step(episode_id, call["name"], call["arguments"])
            env_steps += 1
            messages.append({"role": "tool", "content": step_result["observation"]})
            turn["tool_observation"] = step_result["observation"]
            if step_result.get("done"):
                terminal = env.finish(episode_id)
                break
        if terminal is None:
            terminal = env.finish(episode_id)
        return Rollout(
            task_id=task["task_id"],
            split=task["split"],
            reward=float(terminal["reward"]),
            turns=turns,
            parse_errors=parse_errors,
            env_steps=env_steps,
            finished_explicitly=finished_explicitly,
            messages=messages,
            terminal=terminal,
        )
    finally:
        env.delete_episode(episode_id)


def _oracle_rows() -> list[dict[str, Any]]:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    output = ARTIFACT_DIR / "oracle-train.jsonl"
    subprocess.run(
        ["node", "scripts/automationbench-oracle-trajectories.mjs", "--out", str(output)],
        cwd=REPO,
        check=True,
    )
    rows = [json.loads(line) for line in output.read_text().splitlines() if line.strip()]
    if len(rows) != 48 or any(row.get("split") != "train" or row.get("reward") != 1 for row in rows):
        raise RuntimeError("oracle emitter did not produce exactly 48 perfect train rows")
    return rows


def _actions_from_oracle(row: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for message in row["messages"]:
        if message["role"] != "assistant":
            continue
        calls = parse_tool_calls(message["content"])
        if len(calls) != 1:
            raise RuntimeError(f"oracle row has malformed action: {row['task_id']}")
        actions.append(calls[0])
    return actions


def run_gate(env: EnvService) -> dict[str, Any]:
    hashes = env.hashes()
    if hashes["fixture_sha256"] != EXPECTED_FIXTURE_SHA256 or hashes["split_sha256"] != EXPECTED_SPLITS:
        raise RuntimeError(f"fixture hash mismatch: {hashes}")
    rows = _oracle_rows()
    oracle_rewards: list[float] = []
    for row in rows:
        episode = env.reset(row["task_id"])
        episode_id = episode["episode_id"]
        try:
            for action in _actions_from_oracle(row):
                if action["name"] == "finish":
                    break
                env.step(episode_id, action["name"], action["arguments"])
            oracle_rewards.append(float(env.finish(episode_id)["reward"]))
        finally:
            env.delete_episode(episode_id)
    sentinel_rewards: list[float] = []
    for task in env.tasks("train"):
        episode = env.reset(task["task_id"])
        episode_id = episode["episode_id"]
        try:
            for index in range(3):
                env.step(episode_id, "api_search", {"query": "crm mail endpoints"})
            env.step(
                episode_id,
                "api_fetch",
                {"method": "PATCH", "url": "/crm/contacts/c-0", "body": {"name": "sentinel"}},
            )
            sentinel_rewards.append(float(env.finish(episode_id)["reward"]))
        finally:
            env.delete_episode(episode_id)
    result = {
        "fixture_sha256": hashes["fixture_sha256"],
        "split_sha256": hashes["split_sha256"],
        "oracle_count": len(oracle_rewards),
        "oracle_mean": sum(oracle_rewards) / len(oracle_rewards),
        "sentinel_count": len(sentinel_rewards),
        "sentinel_mean": sum(sentinel_rewards) / len(sentinel_rewards),
    }
    if result["oracle_mean"] != 1.0 or result["sentinel_mean"] != 0.0:
        raise RuntimeError(f"gate failed: {result}")
    print(json.dumps(result, indent=2), flush=True)
    return result


def _renderer_for(model: str) -> tuple[Any, Any, str, str]:
    tokenizer_name, renderer_name = RENDERERS[model]
    tokenizer = get_tokenizer(tokenizer_name)
    renderer = renderers.get_renderer(renderer_name, tokenizer)
    return tokenizer, renderer, tokenizer_name, renderer_name


def _build_datums(rollouts: list[Rollout]) -> list[tinker.Datum]:
    datums: list[tinker.Datum] = []
    for group in _group_by_task(rollouts):
        rewards = [item.reward for item in group]
        if len(set(rewards)) <= 1:
            continue
        advantages = _group_advantages(rewards)
        for episode, advantage in zip(group, advantages, strict=True):
            for turn in episode.turns:
                tokens = turn["tokens"]
                logprobs = turn["logprobs"]
                if not tokens or len(tokens) != len(logprobs):
                    continue
                prompt = turn["prompt"]
                model_input = prompt.append(tinker.EncodedTextChunk(tokens=tokens[:-1]))
                response_start = prompt.length - 1
                datums.append(
                    tinker.Datum(
                        model_input=model_input,
                        loss_fn_inputs={
                            "target_tokens": [0] * response_start + tokens,
                            "logprobs": [0.0] * response_start + logprobs,
                            "advantages": [0.0] * response_start
                            + [advantage] * (model_input.length - response_start),
                        },
                    )
                )
    return datums


def train_step(
    backend: Backend,
    datums: list[tinker.Datum],
    meter: TokenMeter,
    learning_rate: float = 1e-5,
) -> dict[str, Any]:
    """Run one warm-client importance-sampling update.

    This is deliberately not called by the milestone-1 CLI.  It is the shared
    update seam for the Fireworks and Tinker adapters and records the timing
    needed for the later lane comparison.
    """
    if not datums:
        return {"trained": False, "datum_count": 0}
    started = time.monotonic()
    fb_started = time.monotonic()
    forward = backend.training_client.forward_backward(datums, "importance_sampling").result()
    first_gradient_seconds = time.monotonic() - fb_started
    optim_started = time.monotonic()
    backend.training_client.optim_step(
        tinker.AdamParams(
            learning_rate=learning_rate,
            beta1=0.9,
            beta2=0.95,
            eps=1e-8,
            weight_decay=0.0,
        )
    ).result()
    optim_seconds = time.monotonic() - optim_started
    train_tokens = sum(datum.model_input.length for datum in datums)
    meter.add_train(train_tokens)
    return {
        "trained": True,
        "datum_count": len(datums),
        "train_tokens": train_tokens,
        "first_gradient_seconds": first_gradient_seconds,
        "forward_backward_seconds": first_gradient_seconds,
        "optim_step_seconds": optim_seconds,
        "wall_seconds": time.monotonic() - started,
        "receipt": meter.receipt(),
        "forward_metrics": getattr(forward, "metrics", None),
    }


def _group_by_task(rollouts: list[Rollout]) -> list[list[Rollout]]:
    groups: dict[str, list[Rollout]] = {}
    for rollout_result in rollouts:
        groups.setdefault(rollout_result.task_id, []).append(rollout_result)
    return list(groups.values())


def evaluate_model(
    model: str,
    split: str,
    env: EnvService,
    cap: float,
    output: Path,
    backend_name: str = "serverless",
    control: str | None = None,
    transcript_dir: Path | None = None,
    limit: int | None = None,
    temperature: float = 0.0,
    samples: int = 1,
) -> dict[str, Any]:
    tokenizer, renderer, tokenizer_name, renderer_name = _renderer_for(model)
    backend_cls = ServerlessBackend if backend_name == "serverless" else TinkerBackend
    backend = backend_cls(model=model, rank=8)
    meter = TokenMeter(model=model, phase=f"base-{split}")
    started = time.monotonic()
    try:
        snapshot = backend.save_weights_for_sampler(f"automationbench-base-{int(time.time())}")
        sampler = backend.create_sampling_client(snapshot, tokenizer)
        try:
            tasks = env.tasks(split)
            if limit is not None:
                tasks = tasks[:limit]
            rows: list[dict[str, Any]] = []
            for task in tasks:
                for sample_index in range(samples):
                    transform = _control_transform(control)
                    rollout_result = rollout(
                        env,
                        sampler,
                        renderer,
                        task,
                        meter,
                        temperature=temperature,
                        tokenizer=tokenizer,
                        action_transform=transform,
                        prompt_override="" if control == "blank-prompt" else None,
                    )
                    rows.append(
                        {
                            "task_id": rollout_result.task_id,
                            "split": rollout_result.split,
                            "sample_index": sample_index,
                            "reward": rollout_result.reward,
                            "parse_errors": rollout_result.parse_errors,
                            "env_steps": rollout_result.env_steps,
                            "model_turns": len(rollout_result.turns),
                        }
                    )
                    if transcript_dir is not None and len(rows) <= 3:
                        _write_transcript(transcript_dir, model, split, control, rollout_result)
                    meter.enforce_cap(cap)
            summary = {
                "model": model,
                "backend": backend_name,
                "control": control,
                "temperature": temperature,
                "samples_per_task": samples,
                "tokenizer": tokenizer_name,
                "renderer": renderer_name,
                "split": split,
                "count": len(rows),
                "mean_reward": sum(row["reward"] for row in rows) / len(rows),
                "strict_pass_rate": sum(row["reward"] == 1.0 for row in rows) / len(rows),
                "parse_errors": sum(len(row["parse_errors"]) for row in rows),
                "wall_seconds": time.monotonic() - started,
                "receipt": meter.receipt(),
                "rows": rows,
            }
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(summary, indent=2) + "\n")
            print(json.dumps(summary, indent=2), flush=True)
            return summary
        finally:
            sampler.close()
    finally:
        backend.close()


def _control_transform(control: str | None) -> Any | None:
    if control in {None, "blank-prompt"}:
        return None
    if control == "null":
        return lambda _action: {
            "name": "api_search",
            "arguments": {"query": "this-query-cannot-match-anything"},
        }
    if control == "swap":
        def swap(action: dict[str, Any] | None) -> dict[str, Any]:
            if action is None:
                return {
                    "name": "api_search",
                    "arguments": {"query": "this-query-cannot-match-anything"},
                }
            if action["name"] == "api_search":
                return {"name": "api_fetch", "arguments": action["arguments"]}
            if action["name"] == "api_fetch":
                return {"name": "api_search", "arguments": action["arguments"]}
            return action
        return swap
    if control == "forbidden":
        return lambda _action: {
            "name": "api_fetch",
            "arguments": {
                "method": "PATCH",
                "url": "/crm/contacts/c-0",
                "body": {"name": "forbidden-control"},
            },
        }
    raise ValueError(f"unknown control: {control}")


def _release_serverless_session(session_id: str) -> None:
    """Release only the serverless session created by this process."""
    account = os.environ.get("FIREWORKS_ACCOUNT", "understudy-dev")
    url = f"https://api.fireworks.ai/v1/accounts/{account}/trainingSessions/{session_id}"
    request = urllib.request.Request(
        url,
        method="DELETE",
        headers={"X-Api-Key": os.environ["FIREWORKS_API_KEY"]},
    )
    try:
        with urllib.request.urlopen(request, timeout=60):
            return
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        body = error.read().decode(errors="replace")
        raise RuntimeError(
            f"failed to release serverless session {session_id}: "
            f"HTTP {error.code} {body}"
        ) from error


def _list_serverless_sessions() -> list[dict[str, Any]]:
    account = os.environ.get("FIREWORKS_ACCOUNT", "understudy-dev")
    url = f"https://api.fireworks.ai/v1/accounts/{account}/trainingSessions?pageSize=200"
    request = urllib.request.Request(
        url,
        headers={"X-Api-Key": os.environ["FIREWORKS_API_KEY"]},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = json.load(response)
    return payload.get("trainingSessions", [])


def reclaim_serverless_sessions(
    session_ids: list[str] | None,
    created_after: str | None,
    model: str | None,
) -> None:
    if not session_ids and not created_after:
        raise ValueError("reclaim requires --session-id or --created-after")
    sessions = _list_serverless_sessions()
    wanted = set(session_ids or [])
    selected = []
    for session in sessions:
        session_id = str(session.get("name", "")).rsplit("/", 1)[-1]
        if session.get("state") != "READY":
            continue
        if wanted and session_id not in wanted:
            continue
        if created_after and str(session.get("createTime", "")) < created_after:
            continue
        if model and session.get("baseModel") != model:
            continue
        selected.append(session)
    ready_before = sum(session.get("state") == "READY" for session in sessions)
    for session in selected:
        session_id = str(session["name"]).rsplit("/", 1)[-1]
        _release_serverless_session(session_id)
        print(json.dumps({"released": session_id, "base_model": session.get("baseModel")}))
    print(json.dumps({"selected": len(selected), "ready_before": ready_before}))


def _write_transcript(
    directory: Path,
    model: str,
    split: str,
    control: str | None,
    rollout_result: Rollout,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    safe_model = model.replace("/", "__")
    suffix = control or "base"
    payload = {
        "task_id": rollout_result.task_id,
        "split": rollout_result.split,
        "reward": rollout_result.reward,
        "env_steps": rollout_result.env_steps,
        "finished_explicitly": rollout_result.finished_explicitly,
        "parse_errors": rollout_result.parse_errors,
        "turns": [
            {key: value for key, value in turn.items() if key != "prompt"}
            for turn in rollout_result.turns
        ],
        "terminal": rollout_result.terminal,
    }
    path = directory / f"{safe_model}-{split}-{suffix}-{rollout_result.task_id}.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")


def preflight(models: list[str], task_count: int, max_tokens: int, cap: float) -> None:
    print("BASE_EVAL_COST_PREFLIGHT", flush=True)
    for model in models:
        rates = RATES_USD_PER_TOKEN[model]
        worst_prompt_tokens = task_count * MAX_MODEL_TURNS * 4096
        worst_sample_tokens = task_count * MAX_MODEL_TURNS * max_tokens
        estimate = worst_prompt_tokens * rates["prefill"] + worst_sample_tokens * rates["sample"]
        print(
            json.dumps(
                {
                    "model": model,
                    "assumption": "60 tasks, 12 turns/task, 4096 prompt tokens/turn, max output tokens",
                    "worst_case_usd": estimate,
                    "configured_cap": cap,
                }
            ),
            flush=True,
        )
        if estimate > cap:
            raise RuntimeError(f"cost preflight exceeds cap for {model}: {estimate:.4f} > {cap:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["gate", "preflight", "eval", "reclaim"])
    parser.add_argument("--model", choices=sorted(RENDERERS))
    parser.add_argument("--backend", choices=["serverless", "tinker"], default="serverless")
    parser.add_argument(
        "--control",
        choices=["null", "swap", "forbidden", "blank-prompt"],
        default=None,
    )
    parser.add_argument("--transcript-dir", type=Path)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--split", choices=["train", "dev"], default="dev")
    parser.add_argument("--cap", type=float, default=10.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--session-id", action="append")
    parser.add_argument("--created-after")
    args = parser.parse_args()
    env = EnvService(str(REPO)).start()
    try:
        if args.command == "gate":
            run_gate(env)
        elif args.command == "preflight":
            preflight(
                ["accounts/fireworks/models/qwen3p5-9b", "accounts/fireworks/models/qwen3p6-27b"],
                60,
                DEFAULT_MAX_TOKENS,
                args.cap,
            )
        elif args.command == "reclaim":
            reclaim_serverless_sessions(args.session_id, args.created_after, args.model)
        else:
            if not args.model:
                parser.error("--model is required for eval")
            output = args.output or (ARTIFACT_DIR / f"base-{args.model.rsplit('/', 1)[-1]}-{args.split}.json")
            evaluate_model(
                args.model,
                args.split,
                env,
                args.cap,
                output,
                args.backend,
                args.control,
                args.transcript_dir,
                args.limit,
                args.temperature,
                args.samples,
            )
    finally:
        env.stop()


if __name__ == "__main__":
    main()
