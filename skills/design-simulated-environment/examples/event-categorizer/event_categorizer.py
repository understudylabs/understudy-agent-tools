"""event-categorizer — worked example for the traces→env cookbook.

A synthetic event-categorization workload in the shape the cookbook targets:
one lookup tool, a strict JSON output contract, and a playbook (system prompt)
that swaps via `load_environment(playbook_path=...)` so prompt variants A/B on
the same tasks. Quality rides `category_correct` (weight 1.0); the contract
axes (`structured_output_ok`, `tool_calls_ok`, `nonempty_ok`) are zero-weight
metrics — they never move the reward, they surface the failures live traffic
monitoring can't see.

Pinned to the frozen v0 API of `verifiers==0.2.0`. All data here is synthetic.
"""

import contextvars
import json
import re
from pathlib import Path

from datasets import Dataset

import verifiers as vf

HERE = Path(__file__).parent

CATEGORIES = {"billing", "security", "usage", "support", "noise"}
PRIORITIES = {"p0", "p1", "p2", "p3"}
REQUIRED_KEYS = {"category", "priority", "account_ref", "reasoning"}

# Per-rollout account fixtures. Tools are stateless in verifiers — the env
# subclass below parks the current task's fixture in a contextvar before the
# tool runs (concurrency-safe across parallel rollouts).
_ACCOUNTS: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "event_categorizer_accounts", default={}
)


async def lookup_account(account_id: str) -> dict:
    """Look up an account's plan tier and recent incident history.

    Args:
        account_id: The account id referenced by the event, e.g. "acct_401".

    Returns:
        The account record, or {"error": "not_found"} for unknown ids.
    """
    return _ACCOUNTS.get().get(account_id, {"error": "not_found"})


class EventCategorizerEnv(vf.ToolEnv):
    """ToolEnv whose tools see the current task's seeded fixture."""

    async def env_response(self, messages, state, **kwargs):
        _ACCOUNTS.set(state.get("info", {}).get("accounts", {}))
        return await super().env_response(messages, state, **kwargs)


# --- message helpers (accept both typed vf messages and plain dicts) --------


def _field(message, name):
    if isinstance(message, dict):
        return message.get(name)
    return getattr(message, name, None)


def _text(message) -> str:
    content = _field(message, "content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else getattr(part, "text", "") or ""
            for part in content
        )
    return ""


def _last_assistant(completion):
    for message in reversed(completion or []):
        if _field(message, "role") == "assistant":
            return message
    return None


def _tool_calls(completion):
    """Yield (name, raw_arguments) for every tool call in the completion."""
    for message in completion or []:
        for call in _field(message, "tool_calls") or []:
            if isinstance(call, dict):
                fn = call.get("function", call)
                yield fn.get("name"), fn.get("arguments")
            else:
                yield getattr(call, "name", None), getattr(call, "arguments", None)


_FENCE = re.compile(r"^```[a-zA-Z]*\s*\n?(.*?)\n?```\s*$", re.DOTALL)


def _parse_final_json(completion):
    """Parse the final assistant message under the output contract.

    Returns (obj, bare): `obj` is the parsed JSON object (or None), `bare` is
    False when the JSON only parses after stripping markdown fences — the
    exact failure that leaves an SDK's `.object` undefined in production, so
    it must count as a contract fail even though the inner JSON is valid.
    """
    message = _last_assistant(completion)
    text = _text(message).strip() if message is not None else ""
    if not text:
        return None, False
    try:
        return json.loads(text), True
    except (json.JSONDecodeError, ValueError):
        pass
    fenced = _FENCE.match(text)
    if fenced:
        try:
            return json.loads(fenced.group(1)), False
        except (json.JSONDecodeError, ValueError):
            return None, False
    return None, False


def _conforms(obj) -> bool:
    """Minimal schema check for the answer object (stdlib only)."""
    return (
        isinstance(obj, dict)
        and REQUIRED_KEYS.issubset(obj.keys())
        and obj["category"] in CATEGORIES
        and obj["priority"] in PRIORITIES
        and (obj["account_ref"] is None or isinstance(obj["account_ref"], str))
        and isinstance(obj["reasoning"], str)
    )


# --- rubric ------------------------------------------------------------------


def category_correct(completion, answer, **kwargs) -> float:
    """Quality: category (0.7) + priority (0.3) vs gold. Deliberately parses
    fenced JSON too — quality and contract are separate questions, and the
    fenced sentinel in smoke.py proves why both axes are needed."""
    gold = json.loads(answer)
    obj, _bare = _parse_final_json(completion)
    if not isinstance(obj, dict):
        return 0.0
    score = 0.7 if obj.get("category") == gold["category"] else 0.0
    score += 0.3 if obj.get("priority") == gold["priority"] else 0.0
    return round(score, 4)


def structured_output_ok(completion, **kwargs) -> float:
    """Contract: final message is a bare, schema-conformant JSON object."""
    obj, bare = _parse_final_json(completion)
    return 1.0 if bare and _conforms(obj) else 0.0


def tool_calls_ok(completion, **kwargs) -> float:
    """Contract: every tool call names a catalog tool with parseable args."""
    for name, raw_args in _tool_calls(completion):
        if name != "lookup_account":
            return 0.0
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except (json.JSONDecodeError, ValueError):
            return 0.0
        if not isinstance(args, dict) or not isinstance(args.get("account_id"), str):
            return 0.0
    return 1.0


def nonempty_ok(completion, **kwargs) -> float:
    """Contract: the run produced a non-empty final assistant message."""
    message = _last_assistant(completion)
    return 1.0 if message is not None and _text(message).strip() else 0.0


def build_rubric() -> vf.Rubric:
    return vf.Rubric(
        funcs=[category_correct, structured_output_ok, tool_calls_ok, nonempty_ok],
        weights=[1.0, 0.0, 0.0, 0.0],
    )


# --- environment -------------------------------------------------------------


def load_tasks(tasks_path=None) -> list[dict]:
    path = Path(tasks_path) if tasks_path else HERE / "tasks.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_environment(
    tasks_path: str | None = None,
    playbook_path: str | None = None,
    max_turns: int = 4,
    **kwargs,
) -> vf.ToolEnv:
    """Entry point (vf-eval convention). `playbook_path` is the prompt-variant
    knob: `vf-eval event-categorizer -a '{"playbook_path": "playbook-variant.md"}'`
    runs the same frozen tasks under a changed playbook."""
    tasks = load_tasks(tasks_path)
    playbook = Path(playbook_path) if playbook_path else HERE / "playbook.md"
    rows = [
        {
            "question": task["question"],
            "answer": json.dumps(task["gold"]),
            "info": {"accounts": task["accounts"], "gold": task["gold"]},
        }
        for task in tasks
    ]
    return EventCategorizerEnv(
        tools=[lookup_account],
        max_turns=max_turns,
        dataset=Dataset.from_list(rows),
        rubric=build_rubric(),
        system_prompt=playbook.read_text(),
        **kwargs,
    )
