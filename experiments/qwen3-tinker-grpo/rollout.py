"""Shared multi-turn Qwen3 rollout driver for evaluation and RL."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.renderers import Message, get_text_content

from env_client import EnvService

MODEL_NAME = "Qwen/Qwen3-8B"
RENDERER_NAME = "qwen3_disable_thinking"
LORA_RANK = 32
MAX_MODEL_TURNS = 12
MAX_TOKENS = 192
RENDERER_DEVIATION = (
    "Uses qwen3_disable_thinking instead of the default Qwen3 renderer because the "
    "action protocol requires one canonical JSON object per turn; reasoning "
    "traces would make SFT targets non-canonical and increase token cost."
)


def _extract_balanced_json_object(text: str) -> str | None:
    start = -1
    depth = 0
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if start == -1:
            if char == "{":
                start = index
                depth = 1
            continue
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_agent_action(text: str) -> dict[str, Any]:
    """Mirror the Node parseAgentAction contract."""

    source = str(text or "").strip()
    if not source:
        return {"error": "empty assistant message"}
    candidate = _extract_balanced_json_object(source)
    if candidate is None:
        return {"error": "assistant message does not contain a balanced JSON object"}
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError as error:
        return {"error": f"invalid JSON action: {error.msg}: line {error.lineno} column {error.colno} (char {error.pos})"}
    if not isinstance(parsed, dict):
        return {"error": "assistant action must be a JSON object"}
    if parsed.get("finish") is True or parsed.get("tool") == "finish" or parsed.get("name") == "finish":
        return {"finish": True}
    name = parsed.get("tool") if isinstance(parsed.get("tool"), str) else parsed.get("name", "")
    if not name:
        return {"error": "assistant action missing tool/name"}
    raw_arguments = parsed.get("arguments", {})
    if isinstance(raw_arguments, str):
        try:
            raw_arguments = json.loads(raw_arguments)
        except json.JSONDecodeError as error:
            return {"error": f"assistant action arguments are not valid JSON: {error.msg}: line {error.lineno} column {error.colno} (char {error.pos})"}
    if not isinstance(raw_arguments, dict):
        return {"error": "assistant action arguments must be a JSON object"}
    return {"name": name, "arguments": raw_arguments}


def _prompt_token_count(model_input: tinker.ModelInput) -> int:
    total = 0
    for chunk in model_input.chunks:
        tokens = getattr(chunk, "tokens", None)
        if tokens is not None:
            total += len(tokens)
    return total


@dataclass
class RolloutConfig:
    temperature: float
    frozen_holdout_sha256: str | None = None
    max_model_turns: int = MAX_MODEL_TURNS


def _sample_sync(
    sampling_client: tinker.SamplingClient,
    prompt: tinker.ModelInput,
    sampling_params: tinker.SamplingParams,
) -> Any:
    return sampling_client.sample(
        prompt=prompt,
        num_samples=1,
        sampling_params=sampling_params,
    ).result()


async def rollout_task(
    service: EnvService,
    sampling_client: tinker.SamplingClient,
    renderer: renderers.Renderer,
    task: dict[str, Any],
    config: RolloutConfig,
) -> dict[str, Any]:
    reset = service.reset(task["task_id"], config.frozen_holdout_sha256)
    episode_id = reset["episode_id"]
    messages: list[Message] = [
        {"role": "system", "content": reset["system_prompt"]},
        {"role": "user", "content": reset["prompt"]},
    ]
    parse_errors: list[str] = []
    sampled_token_counts: list[int] = []
    prompt_token_counts: list[int] = []
    env_steps = 0
    finished_explicitly = False
    terminal: dict[str, Any] | None = None
    try:
        for _ in range(config.max_model_turns):
            model_input = renderer.build_generation_prompt(messages)
            prompt_token_counts.append(_prompt_token_count(model_input))
            response = await asyncio.to_thread(
                _sample_sync,
                sampling_client,
                model_input,
                tinker.SamplingParams(
                    max_tokens=MAX_TOKENS,
                    temperature=config.temperature,
                    stop=renderer.get_stop_sequences(),
                ),
            )
            sequence = response.sequences[0]
            sampled_token_counts.append(len(sequence.tokens))
            assistant_message, _termination = renderer.parse_response(sequence.tokens)
            assistant_text = get_text_content(assistant_message)
            messages.append({"role": "assistant", "content": assistant_text})
            action = parse_agent_action(assistant_text)
            if "error" in action:
                parse_errors.append(action["error"])
                messages.append(
                    {
                        "role": "tool",
                        "content": json.dumps(
                            {"error": f"{action['error']}. Reply with exactly one JSON object."},
                            separators=(",", ":"),
                        ),
                    }
                )
                continue
            if action.get("finish") is True:
                terminal = service.finish(episode_id)
                finished_explicitly = True
                break
            step = service.step(episode_id, action["name"], action["arguments"])
            env_steps += 1
            messages.append({"role": "tool", "content": step["observation"]})
        if terminal is None:
            terminal = service.finish(episode_id)
        return {
            "task_id": task["task_id"],
            "split": task["split"],
            "family": task["family"],
            "band": task["band"],
            "reward": float(terminal["reward"]),
            "model_turns": len(sampled_token_counts),
            "env_steps": env_steps,
            "forbidden_effects": terminal.get("forbidden_effects", []),
            "parse_errors": parse_errors,
            "finished_explicitly": finished_explicitly,
            "messages": messages,
            "sampled_token_counts": sampled_token_counts,
            "prompt_token_counts": prompt_token_counts,
        }
    finally:
        service.delete_episode(episode_id)
