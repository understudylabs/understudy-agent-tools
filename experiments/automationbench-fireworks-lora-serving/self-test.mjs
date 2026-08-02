#!/usr/bin/env node

import { oraclePolicy, sentinelPolicy, splitCounts, taskPool } from "../../dist/automationbench-offline.js";
import { sanitizeOutgoingMessages } from "./fireworks-client.mjs";
import { runTask } from "./harness.mjs";
import { parseJsonTextMessage } from "./json-text-tools.mjs";

async function scorePolicy(split, makePolicy) {
  const callModel = (taskId) => {
    const policy = makePolicy(taskId);
    let step = 0;
    return async () => {
      const action = policy({ step });
      step += 1;
      return action
        ? {
            role: "assistant",
            tool_calls: [{
              id: `self-test-${step}`,
              type: "function",
              function: {
                name: action.name,
                arguments: JSON.stringify(action.arguments),
              },
            }],
          }
        : { role: "assistant", content: "" };
    };
  };

  const pool = taskPool({ split });
  const scores = [];
  for (const task of pool) {
    const runner = callModel(task.taskId);
    const result = await runTask({ taskId: task.taskId, callModel: runner });
    scores.push(result.score);
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

async function main() {
  const parserAssertions = [
    parseJsonTextMessage("```json\n{\"tool\":\"api_search\",\"arguments\":{\"query\":\"Ada\"}}\n```").assistant.tool_calls?.[0]?.function.name === "api_search",
    parseJsonTextMessage("{\"tool\":\"api_fetch\",\"arguments\":{\"method\":\"GET\",\"url\":\"/crm/contacts\"}}").assistant.tool_calls?.[0]?.function.name === "api_fetch",
    !parseJsonTextMessage("{\"tool\":\"done\"}").assistant.tool_calls && !parseJsonTextMessage("{\"tool\":\"done\"}").malformed,
    parseJsonTextMessage("thought\\n```json\n{\"tool\":\"api_search\",\"arguments\":{\"query\":\"Ada\"}}\n```\\nfinished").assistant.tool_calls?.[0]?.function.name === "api_search",
    parseJsonTextMessage("not valid tool output").malformed && !parseJsonTextMessage("not valid tool output").assistant.tool_calls,
  ];
  const wireMessages = sanitizeOutgoingMessages([
    { role: "system", content: "system", internal_step: 0 },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "<|channel|>thought\nnot valid tool output",
      malformed: true,
      rejected: true,
      step_index: 1,
      reasoning_content: "internal reasoning",
    },
    { role: "tool", tool_call_id: "call-1", content: "result", internal_step: 2 },
  ]);
  const allowedWireKeys = new Set(["role", "content", "name", "tool_calls", "tool_call_id"]);
  const wireAssertion = wireMessages.every((message) =>
    Object.keys(message).every((key) => allowedWireKeys.has(key))
  ) && !Object.hasOwn(wireMessages[2], "malformed")
    && !Object.hasOwn(wireMessages[2], "reasoning_content")
    && !Object.hasOwn(wireMessages[2], "rejected")
    && !Object.hasOwn(wireMessages[2], "step_index");
  const split = "train";
  const oracle = await scorePolicy(split, (taskId) => oraclePolicy(taskId));
  const sentinel = await scorePolicy(split, () => sentinelPolicy());
  process.stdout.write(JSON.stringify({
    split,
    counts: splitCounts(),
    oracle,
    sentinel,
    json_text_parser: {
      assertions: parserAssertions,
      passed: parserAssertions.every(Boolean),
    },
    wire_message_sanitizer: {
      assertion: wireAssertion,
      passed: wireAssertion,
    },
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
