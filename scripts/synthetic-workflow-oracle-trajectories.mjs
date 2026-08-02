#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  finish,
  oraclePolicy,
  reset,
  step,
  taskPool,
} from "../dist/synthetic-workflow-offline.js";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--out");
if (outputIndex < 0 || !args[outputIndex + 1]) {
  throw new Error("--out is required");
}
const output = args[outputIndex + 1];
const tasks = taskPool({ split: "train" });
const rows = [];

for (const task of tasks) {
  const { handle, obs } = reset(task.taskId);
  const messages = obs.messages.map((message) => ({ ...message }));
  const policy = oraclePolicy(task.taskId);
  let current = obs;
  while (!handle.done) {
    const action = policy(current);
    if (!action) break;
    messages.push({
      role: "assistant",
      content: JSON.stringify(action),
    });
    const result = step(handle, action);
    current = result.obs;
    messages.push({
      role: "tool",
      content: current.messages.at(-1)?.content ?? "",
    });
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: 1 } : finish(handle);
  if (terminal.reward !== 1 || handle.forbiddenEffects.length) {
    throw new Error(`oracle failed for ${task.taskId}`);
  }
  rows.push({
    task_id: task.taskId,
    split: task.split,
    family: task.family,
    band: task.band,
    reward: terminal.reward,
    messages,
  });
}

await writeFile(
  output,
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  "utf8",
);
console.log(JSON.stringify({ out: output, rows: rows.length }));
