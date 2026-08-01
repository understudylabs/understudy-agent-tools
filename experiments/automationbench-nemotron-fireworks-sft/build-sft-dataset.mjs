#!/usr/bin/env node

// Experiment notes, receipts, and reproduction commands: ./README.md

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TASKS,
  finish,
  getTask,
  oraclePolicy,
  reset,
  step,
} from "../../dist/automationbench-offline.js";
import { toolSchemas } from "./harness.mjs";

function buildRecord(task) {
  if (task.split !== "train") throw new Error(`refusing non-train task: ${task.taskId}`);
  const { handle, obs: initial } = reset(task.taskId);
  const messages = [...initial.messages];
  let observation = initial;
  const policy = oraclePolicy(task.taskId);
  let lastResult;
  while (!handle.done) {
    const call = policy(observation);
    if (!call) break;
    const id = `oracle-${handle.step + 1}`;
    messages.push({
      role: "assistant",
      tool_calls: [{
        id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }],
    });
    lastResult = step(handle, call);
    observation = lastResult.obs;
    messages.push({ role: "tool", tool_call_id: id, content: lastResult.obs.messages.at(-1).content });
    if (lastResult.done) break;
  }
  const terminal = lastResult?.done ? lastResult : finish(handle);
  if (terminal.reward !== 1) throw new Error(`oracle replay did not score 1.0: ${task.taskId}`);
  messages.push({ role: "assistant", content: "The task is complete." });
  return { taskId: task.taskId, record: { messages, tools: toolSchemas() } };
}

export function buildDataset(outputPath) {
  if (!outputPath) throw new Error("usage: node build-sft-dataset.mjs <output.jsonl>");
  const train = TASKS.filter((task) => task.split === "train");
  if (train.length !== 48) throw new Error(`expected 48 train tasks, found ${train.length}`);
  const ids = new Set(train.map((task) => task.taskId));
  const built = train.map(buildRecord);
  for (const { taskId } of built) {
    if (!ids.has(taskId) || getTask(taskId).split !== "train") throw new Error(`dataset contains non-train task: ${taskId}`);
  }
  const records = built.map((entry) => entry.record);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeFileSync(outputPath, text);
  writeFileSync(`${outputPath}.task-ids.json`, `${JSON.stringify(built.map((entry) => entry.taskId), null, 2)}\n`);
  const summary = {
    records: records.length,
    total_chars: text.length,
    estimated_tokens: Math.ceil(text.length / 4),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildDataset(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
