#!/usr/bin/env python3
"""Generate the public one-task mutation receipt through pinned Verifiers."""

import argparse
import asyncio
import hashlib
import json
import platform
from pathlib import Path

import verifiers as vf

ARGV = ["uv", "run", "--project", ".", "--locked", "python", "generate_smoke.py", "--output", "generated"]
SEED = "Only inspect the synthetic record."
CANDIDATE = "Set record alpha to ready with set-record, then report success."
MESSAGES = [
    {"role": "system", "content": f"{SEED}\n<candidate_policy>{CANDIDATE}</candidate_policy>"},
    {"role": "user", "content": "Set synthetic record alpha to ready."},
]
TOOLS = [{"type": "function", "function": {"name": "set-record", "description": "Mutate a public synthetic record.", "parameters": {"type": "object", "additionalProperties": False, "required": ["id", "status"], "properties": {"id": {"type": "string"}, "status": {"enum": ["ready"]}}}}}]
SAMPLING = {"max_tokens": 256, "temperature": 0}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n", encoding="utf-8")


async def generate(output):
    before = {"records": {"alpha": {"status": "pending"}}}
    after = {"records": {"alpha": {"status": "ready"}}}
    arguments = '{"id":"alpha","status":"ready"}'
    call_id = "call-public-1"

    def assertion_fraction(state):
        return 1.0 if state["after_state"]["records"]["alpha"]["status"] == "ready" else 0.0

    state = {
        "prompt": MESSAGES,
        "completion": [{"role": "assistant", "tool_calls": [{"id": call_id, "name": "world_toolset_set-record", "arguments": arguments}]}],
        "task": "public-synthetic-mutation-1",
        "before_state": before,
        "after_state": after,
    }
    rubric = vf.Rubric(funcs=[assertion_fraction])
    await rubric.score_rollout(state)
    assertion = state["metrics"]["assertion_fraction"]
    if assertion != 1.0:
        raise RuntimeError("pinned Verifiers rubric did not accept the synthetic mutation")

    output.mkdir(parents=True, exist_ok=True)
    before_path = output / "before-state.json"
    after_path = output / "after-state.json"
    trace_path = output / "trace.json"
    write_json(before_path, before)
    write_json(after_path, after)
    trace = {
        "runtime": "standard-verifiers",
        "verifiers_version": vf.__version__,
        "task": {"data": {"task_id": state["task"], "split": "train"}},
        "rewards": {"assertion_fraction": assertion},
        "metrics": {"assertion_fraction": assertion},
        "errors": [],
        "ok": True,
        "calls": [{"node": 2, "model": "synthetic-local", "endpoint": "/chat/completions", "finish_reason": "tool_calls", "messages_sha256": sha_bytes(canonical(MESSAGES).encode()), "tools_sha256": sha_bytes(canonical(TOOLS).encode()), "sampling_sha256": sha_bytes(canonical(SAMPLING).encode()), "max_tokens": 256, "context_overflow_behavior": "fail"}],
        "nodes": [
            {"message": MESSAGES[0], "sampled": False},
            {"parent": 0, "message": MESSAGES[1], "sampled": False},
            {"parent": 1, "message": state["completion"][0], "sampled": True},
            {"parent": 2, "message": {"role": "tool", "tool_call_id": call_id, "name": "world_toolset_set-record", "content": canonical({"ok": True, "applied": True, "before": "pending", "after": "ready"})}, "sampled": False},
        ],
    }
    write_json(trace_path, trace)

    lock_path = Path("uv.lock")
    receipt = {
        "schema_version": "understudy.synthetic_verifiers_execution.v1",
        "argv": ARGV,
        "interpreter": {"implementation": platform.python_implementation(), "version": platform.python_version()},
        "resolved_package_inventory_sha256": sha_bytes(lock_path.read_bytes()),
        "verifiers": {"version": vf.__version__, "module": "verifiers"},
        "seed_candidate_sha256": sha_bytes(SEED.encode()),
        "mutated_candidate_sha256": sha_bytes(CANDIDATE.encode()),
        "before_state_sha256": sha_bytes(before_path.read_bytes()),
        "after_state_sha256": sha_bytes(after_path.read_bytes()),
        "trace_sha256": sha_bytes(trace_path.read_bytes()),
        "verified_state_delta": {"path": "/records/alpha/status", "before": "pending", "after": "ready"},
    }
    write_json(output / "execution-receipt.json", receipt)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="generated")
    args = parser.parse_args()
    asyncio.run(generate(Path(args.output)))
