"""captures JSONL → tasks.jsonl + playbook.md (stdlib only).

Turns a directory-of-truth you already have — gateway capture exports or
OpenAI-style request/response logs — into this example's task format so the
env runs on *your* workload instead of the synthetic fixture.

Accepted line shapes (auto-detected per line):
  A) {"request": {"messages": [...], ...}, "response": {"choices": [...]}}
  B) {"messages": [...], "response": {...}}          (flat request + response)
  C) {"body": {...}, "response": {"body": {...}}}    (batch-style)

What it extracts per call:
  - system message      → the playbook (written once; calls whose system
                          prompt differs are a DIFFERENT workload and are
                          skipped with a count — one env per workload)
  - last user message   → `question`
  - final assistant     → `gold` when --gold=response ("trusted incumbent":
                          only valid when the captured model was doing the
                          job well; otherwise emit gold=null and label rows
                          by hand or from your test expectations)
  - tool calls/results  → recorded into `info.recorded_tools` so you can
                          derive replay stubs or per-task fixtures

Honest limits: this handles single-turn(+tools) request/response captures.
Multi-turn agent loops need a seeded fixture instead of replay — see the
cookbook's stage 2 and prepare-verifier-handoff/references/stage-1-author-env.md.

REDACT FIRST: run captures through ingest-traces before converting; the
output of this script contains whatever the input contains.

Usage:
  python convert_captures.py --captures captures.jsonl --out-dir ./my-workload \
      [--gold response|none] [--min-rows 10]
"""

import argparse
import hashlib
import json
from pathlib import Path


def _first(mapping, *keys):
    for key in keys:
        if isinstance(mapping, dict) and mapping.get(key) is not None:
            return mapping[key]
    return None


def extract_call(line_obj):
    """Normalize one capture line to (messages, response_message) or None."""
    request = _first(line_obj, "request", "body") or line_obj
    messages = _first(request, "messages")
    if messages is None:
        return None
    response = _first(line_obj, "response") or {}
    response_body = _first(response, "body") or response
    choices = _first(response_body, "choices") or []
    response_message = choices[0].get("message") if choices else None
    return messages, response_message


def text_of(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return ""


def to_task(messages, response_message, index, gold_mode):
    system = next((m for m in messages if m.get("role") == "system"), None)
    users = [m for m in messages if m.get("role") == "user"]
    if not users:
        return None, None
    recorded_tools = []
    for message in messages + ([response_message] if response_message else []):
        if not isinstance(message, dict):
            continue
        for call in message.get("tool_calls") or []:
            fn = call.get("function", call)
            recorded_tools.append(
                {"name": fn.get("name"), "arguments": fn.get("arguments")}
            )
        if message.get("role") == "tool":
            recorded_tools.append({"result": text_of(message)})

    gold = None
    if gold_mode == "response" and response_message is not None:
        raw = text_of(response_message).strip()
        try:
            gold = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            gold = {"raw": raw} if raw else None

    task = {
        "task_id": f"cap-{index:04d}",
        "question": text_of(users[-1]),
        "gold": gold,
        "accounts": {},  # fill with per-task fixture state your tools read
        "info": {"recorded_tools": recorded_tools},
    }
    return task, (text_of(system) if system else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--gold", choices=["response", "none"], default="response")
    parser.add_argument("--min-rows", type=int, default=10)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    tasks, playbook, skipped_other_workload, skipped_unparsed = [], None, 0, 0
    playbook_hash = None
    for line in Path(args.captures).read_text().splitlines():
        if not line.strip():
            continue
        try:
            extracted = extract_call(json.loads(line))
        except (json.JSONDecodeError, ValueError):
            extracted = None
        if extracted is None:
            skipped_unparsed += 1
            continue
        messages, response_message = extracted
        task, system_text = to_task(messages, response_message, len(tasks), args.gold)
        if task is None:
            skipped_unparsed += 1
            continue
        current_hash = hashlib.sha256(system_text.encode()).hexdigest()[:12]
        if playbook_hash is None:
            playbook_hash, playbook = current_hash, system_text
        elif current_hash != playbook_hash:
            skipped_other_workload += 1  # different system prompt = different workload
            continue
        tasks.append(task)

    (out_dir / "tasks.jsonl").write_text(
        "".join(json.dumps(task) + "\n" for task in tasks)
    )
    (out_dir / "playbook.md").write_text(playbook or "")
    print(f"tasks: {len(tasks)}  (workload playbook {playbook_hash})")
    print(f"skipped: {skipped_other_workload} other-workload, {skipped_unparsed} unparsed")
    if len(tasks) < args.min_rows:
        print(f"WARNING: fewer than {args.min_rows} rows — a gate needs more tasks")
    if args.gold == "response":
        print("gold = captured responses (trusted-incumbent mode): spot-check them")
    print("next: freeze splits (capture-evidence) before anyone optimizes against these")


if __name__ == "__main__":
    main()
