"""Offline conformance check — no network, no model, no API key.

Proves the env + validator are right before any model score is trusted
(the skill's oracle + sentinel gates):

1. the environment constructs (dataset/rubric/tool wiring is valid);
2. a scripted oracle trajectory scores reward 1.0 with all contract axes 1.0;
3. sentinels the validator must reject actually fail — including the
   right-answer-wrong-contract sentinel (gold JSON wrapped in markdown
   fences), which quality axes alone would PASS. That sentinel is the whole
   reason contract axes exist: in production it is the run where monitoring
   shows zero errors while every downstream parse breaks.

Run: uv run --with verifiers==0.2.0 smoke.py
"""

import asyncio
import json

from verifiers.types import AssistantMessage, ToolCall, ToolMessage

from event_categorizer import build_rubric, load_environment, load_tasks


def state_for(task, completion):
    return {
        "prompt": [{"role": "user", "content": task["question"]}],
        "completion": completion,
        "answer": json.dumps(task["gold"]),
        "info": {"accounts": task["accounts"], "gold": task["gold"]},
        "task": "default",
    }


def oracle_completion(task):
    """The scripted correct trajectory: look up the account (when the event
    names one), then answer with the bare gold JSON object."""
    messages = []
    account_ref = task["gold"]["account_ref"]
    if account_ref:
        call = ToolCall(
            id="call_1",
            name="lookup_account",
            arguments=json.dumps({"account_id": account_ref}),
        )
        messages.append(AssistantMessage(content=None, tool_calls=[call]))
        messages.append(
            ToolMessage(
                tool_call_id="call_1",
                content=json.dumps(task["accounts"].get(account_ref, {})),
            )
        )
    messages.append(AssistantMessage(content=json.dumps(task["gold"])))
    return messages


def score(rubric, state):
    # score_rollout returns None: it writes state["reward"] / state["metrics"]
    asyncio.run(rubric.score_rollout(state))
    return state["reward"], state["metrics"]


def main():
    env = load_environment()
    assert env is not None, "environment failed to construct"
    tasks = load_tasks()
    assert len(tasks) >= 10, "expected the full task set"
    rubric = build_rubric()
    failures = []

    # 1) oracle must score perfectly on every task
    for task in tasks:
        reward, metrics = score(rubric, state_for(task, oracle_completion(task)))
        for axis in ("structured_output_ok", "tool_calls_ok", "nonempty_ok"):
            if metrics[axis] != 1.0:
                failures.append(f"{task['task_id']}: oracle {axis}={metrics[axis]}")
        if reward != 1.0:
            failures.append(f"{task['task_id']}: oracle reward={reward}")

    # 2) sentinels (plain-dict messages exercise the dict path too)
    sentinel_task = tasks[0]
    gold_json = json.dumps(sentinel_task["gold"])

    empty = [{"role": "assistant", "content": ""}]
    reward, metrics = score(rubric, state_for(sentinel_task, empty))
    if reward != 0.0 or metrics["nonempty_ok"] != 0.0:
        failures.append(f"empty sentinel not rejected: reward={reward}")

    fenced = [{"role": "assistant", "content": f"```json\n{gold_json}\n```"}]
    reward, metrics = score(rubric, state_for(sentinel_task, fenced))
    if metrics["structured_output_ok"] != 0.0:
        failures.append("fenced sentinel passed the contract axis")
    if reward != 1.0:
        failures.append(
            f"fenced sentinel should keep quality reward 1.0 (got {reward}) — "
            "quality and contract must separate"
        )

    bad_tool = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "x", "function": {"name": "delete_account", "arguments": "{}"}}
            ],
        },
        {"role": "assistant", "content": gold_json},
    ]
    _, metrics = score(rubric, state_for(sentinel_task, bad_tool))
    if metrics["tool_calls_ok"] != 0.0:
        failures.append("off-catalog tool call passed tool_calls_ok")

    wrong = dict(sentinel_task["gold"], category="noise", priority="p3")
    plausible = [{"role": "assistant", "content": json.dumps(wrong)}]
    reward, metrics = score(rubric, state_for(sentinel_task, plausible))
    if reward != 0.0:
        failures.append(f"plausible-but-wrong sentinel scored {reward}")
    if metrics["structured_output_ok"] != 1.0:
        failures.append("wrong-values sentinel should still satisfy the contract")

    if failures:
        print("SMOKE FAIL")
        for failure in failures:
            print(f"  - {failure}")
        raise SystemExit(1)
    print(f"SMOKE OK — env constructs; oracle 1.0 on {len(tasks)} tasks; 4 sentinels behave")


if __name__ == "__main__":
    main()
