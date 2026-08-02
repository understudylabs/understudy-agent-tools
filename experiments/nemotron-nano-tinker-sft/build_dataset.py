from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from driver import ARTIFACTS, BASE, EnvDaemon, tool_specs
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer


def message_from_row(row):
    if row["role"] in {"system", "user", "tool"}:
        return renderers.Message(role=row["role"], content=row.get("content", ""))
    calls = []
    for call in row.get("tool_calls", []):
        fn = call["function"]
        calls.append(
            renderers.ToolCall(
                type="function",
                id=None,
                function=renderers.ToolCall.FunctionBody(
                    name=fn["name"], arguments=fn["arguments"]
                ),
            )
        )
    return renderers.Message(role="assistant", content=row.get("content", ""), tool_calls=calls)


def compact_datum(datum, loss_mask):
    return {
        "tokens": datum.to_ints(),
        "loss_mask": [int(value) for value in loss_mask.tolist()],
        "length": int(datum.length),
    }


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ARTIFACTS)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    daemon = EnvDaemon()
    try:
        tasks = daemon.call("pool", split="train")
        tokenizer = get_tokenizer(BASE)
        train_path = args.output_dir / "oracle-train.jsonl"
        datum_path = args.output_dir / "oracle-train-datums.jsonl"
        total_tokens = 0
        rows = []
        datums = []
        with train_path.open("w", encoding="utf-8") as raw_out, datum_path.open("w", encoding="utf-8") as datum_out:
            for task in tasks:
                trajectory = daemon.call("oracle_trajectory", taskId=task["taskId"])
                obs = trajectory["transcript"][0]["obs"]
                messages = [
                    {"role": "system", "content": obs["messages"][0]["content"]},
                    {"role": "user", "content": obs["messages"][1]["content"]},
                ]
                for event in trajectory["transcript"][1:]:
                    if event["type"] == "action":
                        action = event["action"]
                        messages.append(
                            {
                                "role": "assistant",
                                "content": "",
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": action["name"],
                                            "arguments": json.dumps(action["arguments"], separators=(",", ":")),
                                        }
                                    }
                                ],
                            }
                        )
                        messages.append({"role": "tool", "content": event["result"]["obs"]["messages"][-1]["content"]})
                messages.append({"role": "assistant", "content": "Done."})
                row = {"task_id": task["taskId"], "messages": messages}
                raw_out.write(json.dumps(row, separators=(",", ":")) + "\n")
                rows.append(row)

                renderer = renderers.get_renderer("nemotron3", tokenizer)
                rendered = renderer.create_conversation_prefix_with_tools(
                    tool_specs(obs), system_prompt=obs["messages"][0]["content"]
                )
                rendered.extend(message_from_row(message) for message in messages[1:])
                datum, loss_mask = renderer.build_supervised_example(
                    rendered, train_on_what=renderers.TrainOnWhat.ALL_ASSISTANT_MESSAGES
                )
                converted = {"task_id": task["taskId"], **compact_datum(datum, loss_mask)}
                datum_out.write(json.dumps(converted, separators=(",", ":")) + "\n")
                datums.append(converted)
                total_tokens += converted["length"]
        task_ids = {row["task_id"] for row in rows}
        assert len(rows) == 48
        assert all(task_id.startswith("simple-api-") for task_id in task_ids)
        dev_ids = {task["taskId"] for task in daemon.call("pool", split="dev")}
        assert task_ids.isdisjoint(dev_ids)
        # The daemon deliberately has no implicit holdout read. The fixture's
        # split contract is checked by the Node gates without materializing
        # holdout tasks in this dataset process.
        assert not any("holdout" in task_id.lower() for task_id in task_ids)
        summary = {
            "examples": len(rows),
            "total_train_tokens": total_tokens,
            "raw_jsonl": str(train_path),
            "tinker_datums_jsonl": str(datum_path),
            "holdout_accessed": False,
        }
        (args.output_dir / "dataset-stats.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(summary, indent=2))
    finally:
        daemon.close()


if __name__ == "__main__":
    asyncio.run(main())
