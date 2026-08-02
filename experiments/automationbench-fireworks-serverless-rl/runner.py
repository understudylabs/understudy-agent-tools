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

    def add_sampling(self, prompt_tokens: int, sample_tokens: int) -> None:
        self.prefill_tokens += prompt_tokens
        self.sample_tokens += sample_tokens

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
        close = getattr(self.service, "close", None)
        if close:
            close()


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
        return self.service.create_sampling_client(model_path=model_path, tokenizer=tokenizer)

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


def rollout(
    env: EnvService,
    sampling_client: Any,
    renderer: Any,
    task: dict[str, Any],
    meter: TokenMeter,
    temperature: float,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> Rollout:
    reset = env.reset(task["task_id"])
    episode_id = reset["episode_id"]
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
            result = sampling_client.sample(
                prompt=prompt,
                num_samples=1,
                sampling_params=tinker.SamplingParams(
                    max_tokens=max_tokens,
                    temperature=temperature,
                    stop=renderer.get_stop_sequences(),
                ),
            ).result()
            sequence = result.sequences[0]
            tokens = list(getattr(sequence, "tokens", []) or [])
            logprobs = list(getattr(sequence, "logprobs", []) or [])
            meter.add_sampling(_prompt_length(prompt), len(tokens))
            assistant_message, termination = renderer.parse_response(tokens)
            text = get_text_content(assistant_message)
            messages.append({"role": "assistant", "content": text})
            turn = {
                "prompt": prompt,
                "tokens": tokens,
                "logprobs": [float(value) for value in logprobs],
                "text": text,
                "termination": str(termination),
            }
            turns.append(turn)
            calls = parse_tool_calls(text)
            if len(calls) != 1 or calls[0]["name"] not in {"api_search", "api_fetch", "finish"}:
                error = "expected exactly one api_search, api_fetch, or finish tool call"
                parse_errors.append(error)
                messages.append(
                    {"role": "tool", "content": json.dumps({"error": error}, separators=(",", ":"))}
                )
                continue
            call = calls[0]
            if call["name"] == "finish":
                terminal = env.finish(episode_id)
                finished_explicitly = True
                break
            step_result = env.step(episode_id, call["name"], call["arguments"])
            env_steps += 1
            messages.append({"role": "tool", "content": step_result["observation"]})
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
            rows: list[dict[str, Any]] = []
            for task in tasks:
                rollout_result = rollout(env, sampler, renderer, task, meter, temperature=0.0)
                rows.append(
                    {
                        "task_id": rollout_result.task_id,
                        "split": rollout_result.split,
                        "reward": rollout_result.reward,
                        "parse_errors": rollout_result.parse_errors,
                        "env_steps": rollout_result.env_steps,
                        "model_turns": len(rollout_result.turns),
                    }
                )
                meter.enforce_cap(cap)
            summary = {
                "model": model,
                "backend": backend_name,
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
    parser.add_argument("command", choices=["gate", "preflight", "eval"])
    parser.add_argument("--model", choices=sorted(RENDERERS))
    parser.add_argument("--backend", choices=["serverless", "tinker"], default="serverless")
    parser.add_argument("--split", choices=["train", "dev"], default="dev")
    parser.add_argument("--cap", type=float, default=10.0)
    parser.add_argument("--output", type=Path)
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
        else:
            if not args.model:
                parser.error("--model is required for eval")
            output = args.output or (ARTIFACT_DIR / f"base-{args.model.rsplit('/', 1)[-1]}-{args.split}.json")
            evaluate_model(args.model, args.split, env, args.cap, output, args.backend)
    finally:
        env.stop()


if __name__ == "__main__":
    main()
