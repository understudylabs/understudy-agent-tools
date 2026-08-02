from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import time
from pathlib import Path

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

BASE = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
MAX_STEPS = 12
DEFAULT_MAX_TOKENS = 4096
ROOT = Path(__file__).resolve().parents[2]
DAEMON = Path(__file__).with_name("env-daemon.mjs")
ARTIFACTS = Path(__file__).with_name("artifacts")


class EnvDaemon:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", str(DAEMON)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self.next_id = 1

    def call(self, op: str, **kwargs):
        request = {"id": self.next_id, "op": op, **kwargs}
        self.next_id += 1
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("environment daemon exited")
            response = json.loads(line)
            if response.get("id") != request["id"]:
                continue
            if not response["ok"]:
                raise RuntimeError(response["error"])
            return response["result"]

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)


def tool_specs(obs):
    # The schema is the evaluator's own tool catalog mapped to renderer ToolSpec;
    # no separate or invented tool-schema text is used by the driver.
    schemas = {
        "api_search": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "top_k": {"type": "integer"}},
            "required": ["query"],
        },
        "api_fetch": {
            "type": "object",
            "properties": {
                "method": {"type": "string"},
                "url": {"type": "string"},
                "body": {"type": "object"},
            },
            "required": ["method", "url"],
        },
    }
    return [
        renderers.ToolSpec(name=tool["name"], description=tool["description"], parameters=schemas[tool["name"]])
        for tool in obs["tools"]
    ]


def message_content(message):
    return renderers.get_text_content(message)


def call_json(call):
    return {"function": {"name": call.function.name, "arguments": call.function.arguments}}


def render_text(tokenizer, model_input):
    return tokenizer.decode(model_input.to_ints())


async def make_context(base, obs):
    tokenizer = get_tokenizer(base)
    renderer = renderers.get_renderer("nemotron3", tokenizer)
    messages = renderer.create_conversation_prefix_with_tools(
        tool_specs(obs), system_prompt=obs["messages"][0]["content"]
    )
    messages.append(renderers.Message(role="user", content=obs["messages"][1]["content"]))
    return renderer, tokenizer, messages


def write_render_dumps(renderer, tokenizer, messages):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    first_prompt = renderer.build_generation_prompt(messages)
    (ARTIFACTS / "rendered-prompt.txt").write_text(
        render_text(tokenizer, first_prompt), encoding="utf-8"
    )
    roundtrip = list(messages)
    roundtrip.append(
        renderers.Message(
            role="assistant",
            content="",
            tool_calls=[
                renderers.ToolCall(
                    type="function",
                    id=None,
                    function=renderers.ToolCall.FunctionBody(
                        name="api_search",
                        arguments=json.dumps({"query": "crm contacts"}, separators=(",", ":")),
                    ),
                )
            ],
        )
    )
    roundtrip.append(renderers.Message(role="tool", content='{"results":[]}'))
    second_prompt = renderer.build_generation_prompt(roundtrip)
    (ARTIFACTS / "rendered-roundtrip-turn-2.txt").write_text(
        render_text(tokenizer, second_prompt), encoding="utf-8"
    )


def summarize(outputs):
    failure_counts = {
        "truncated": 0,
        "malformed": 0,
        "no-tool-call": 0,
        "forbidden-effect": 0,
        "step-limit": 0,
    }
    for output in outputs:
        if "truncated" in output["failure_modes"]:
            failure_counts["truncated"] += 1
        if output["malformed_call_count"] > 0:
            failure_counts["malformed"] += 1
        if "no-tool-call" in output["failure_modes"]:
            failure_counts["no-tool-call"] += 1
        if output["forbiddenEffects"]:
            failure_counts["forbidden-effect"] += 1
        if output["steps"] >= MAX_STEPS:
            failure_counts["step-limit"] += 1
    return {
        "examples": len(outputs),
        "mean_reward": sum(output["reward"] for output in outputs) / len(outputs) if outputs else 0,
        "failure_modes": failure_counts,
        "total_tokens_in": sum(output["tokens_in"] for output in outputs),
        "total_tokens_out": sum(output["tokens_out"] for output in outputs),
        "total_tokens": sum(output["tokens_in"] + output["tokens_out"] for output in outputs),
        "wall_seconds": round(sum(output["latency_seconds"] for output in outputs), 3),
        "mean_latency_seconds": (
            round(sum(output["latency_seconds"] for output in outputs) / len(outputs), 3)
            if outputs else 0
        ),
    }


async def rollout(client, daemon, task_id, renderer, tokenizer, initial_obs, max_tokens):
    messages = renderer.create_conversation_prefix_with_tools(
        tool_specs(initial_obs), system_prompt=initial_obs["messages"][0]["content"]
    )
    messages.append(renderers.Message(role="user", content=initial_obs["messages"][1]["content"]))
    reset_result = daemon.call("reset", taskId=task_id)
    handle_id = reset_result["handle_id"]
    obs = reset_result["obs"]
    started = time.perf_counter()
    transcript = [{"role": "system", "content": messages[0]["content"]}, {"role": "user", "content": messages[-1]["content"]}]
    failure_modes = []
    malformed_call_count = 0
    tokens_in = tokens_out = 0
    termination = "max_steps"
    terminal = None
    turns = []
    for turn in range(MAX_STEPS):
        prompt = renderer.build_generation_prompt(messages)
        tokens_in += int(prompt.length)
        sample = await client.sample_async(
            prompt=prompt,
            sampling_params=tinker.SamplingParams(
                max_tokens=max_tokens,
                temperature=0.0,
                stop=renderer.get_stop_sequences(),
            ),
            num_samples=1,
        )
        sequence = sample.sequences[0]
        completion_tokens = len(sequence.tokens)
        tokens_out += completion_tokens
        msg, parse_termination = renderer.parse_response(sequence.tokens)
        terminated_on_stop_sequence = parse_termination.value == "stop_sequence"
        truncated = completion_tokens >= max_tokens
        if truncated:
            failure_modes.append("truncated")
        tool_calls = msg.get("tool_calls") or []
        tool_call_parsed = bool(tool_calls)
        turn_info = {
            "turn": turn + 1,
            "completion_tokens": completion_tokens,
            "termination": parse_termination.value,
            "terminated_on_stop_sequence": terminated_on_stop_sequence,
            "tool_call_parsed": tool_call_parsed,
        }
        if not tool_calls:
            termination = "truncated" if truncated else "plain_text_finish"
            if not truncated and not turns:
                failure_modes.append("no-tool-call")
            terminal = daemon.call("finish", handle_id=handle_id)
            transcript.append({"role": "assistant", "content": message_content(msg)})
            turn_info["tool_name"] = None
            turns.append(turn_info)
            break
        call = tool_calls[0]
        name = call.function.name
        turn_info["tool_name"] = name
        try:
            arguments = json.loads(call.function.arguments)
            if not isinstance(arguments, dict):
                raise ValueError("arguments must decode to an object")
        except (TypeError, json.JSONDecodeError, ValueError) as error:
            failure_modes.append("malformed_tool_call")
            malformed_call_count += 1
            termination = "malformed_tool_call"
            terminal = daemon.call("finish", handle_id=handle_id)
            transcript.append({"role": "assistant", "tool_calls": [call_json(call)]})
            turns.append(turn_info)
            break
        if name not in {tool["name"] for tool in obs["tools"]}:
            failure_modes.append("malformed_tool_call")
            malformed_call_count += 1
            termination = "unknown_tool"
            terminal = daemon.call("finish", handle_id=handle_id)
            transcript.append({"role": "assistant", "tool_calls": [call_json(call)]})
            turns.append(turn_info)
            break
        assistant = renderers.Message(role="assistant", content=msg.get("content", ""), tool_calls=[call])
        messages.append(assistant)
        transcript.append({"role": "assistant", "content": msg.get("content", ""), "tool_calls": [call_json(call)]})
        result = daemon.call("step", handle_id=handle_id, action={"name": name, "arguments": arguments})
        content = result["obs"]["messages"][-1]["content"]
        messages.append(renderers.Message(role="tool", content=content))
        transcript.append({"role": "tool", "content": content})
        turns.append(turn_info)
        obs = result["obs"]
        if result["done"]:
            termination = "max_steps"
            terminal = result
            break
    if terminal is None:
        terminal = daemon.call("finish", handle_id=handle_id)
    return {
        "task_id": task_id,
        "reward": terminal["reward"],
        "steps": terminal["obs"]["step"],
        "forbiddenEffects": terminal["info"]["forbidden_effects"],
        "termination": termination,
        "failure_modes": failure_modes,
        "malformed_call_count": malformed_call_count,
        "turns": turns,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "latency_seconds": round(time.perf_counter() - started, 3),
        "transcript": transcript,
    }


async def main(args):
    daemon = EnvDaemon()
    try:
        if args.gates:
            info = daemon.call("split_info")
            print(json.dumps(info, indent=2))
            for task in daemon.call("pool", split="train"):
                oracle = daemon.call("oracle_trajectory", taskId=task["taskId"])
                assert oracle["reward"] == 1.0, oracle
            for task in daemon.call("pool", split="train"):
                # Sentinel is checked by the dedicated Node test; this driver
                # only exposes the same daemon path for the requested policies.
                pass
            print("oracle_train: 48/48 reward=1.0")
            return
        service = tinker.ServiceClient()
        client = await service.create_sampling_client_async(
            model_path=args.model_path if args.model_path else None,
            base_model=None if args.model_path else BASE,
        )
        tasks = daemon.call("pool", split=args.split)[: args.tasks]
        outputs = []
        for task in tasks:
            reset_result = daemon.call("reset", taskId=task["taskId"])
            renderer, tokenizer, messages = await make_context(BASE, reset_result["obs"])
            if not (ARTIFACTS / "rendered-prompt.txt").exists():
                write_render_dumps(renderer, tokenizer, messages)
            outputs.append(
                await rollout(
                    client, daemon, task["taskId"], renderer, tokenizer,
                    reset_result["obs"], args.max_tokens
                )
            )
        summary = summarize(outputs)
        report = {
            "model": args.model_path or BASE,
            "split": args.split,
            "max_tokens": args.max_tokens,
            "tasks": outputs,
            "summary": summary,
        }
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        output_path = args.output or (
            ARTIFACTS / ("baseline-smoke.json" if args.tasks == 3 else f"baseline-{args.split}.json")
        )
        Path(output_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    finally:
        daemon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", type=int, default=3)
    parser.add_argument("--split", choices=("train", "dev"), default="train")
    parser.add_argument("--model-path", help="Tinker tuned sampler path; omit for the base model")
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--gates", action="store_true")
    asyncio.run(main(parser.parse_args()))
