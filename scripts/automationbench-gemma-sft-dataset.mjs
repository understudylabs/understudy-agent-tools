#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TASKS,
  auditObservationLeakage,
  fixtureSha256,
  reset,
  splitSha256,
  step,
} from "../dist/automationbench-offline.js";
import { TOOLS } from "./automationbench-gemma-harness.mjs";

function assistantToolMessage(call, callIndex) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: `oracle_${callIndex}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }],
  };
}

export function buildSftRecords() {
  const train = TASKS.filter((task) => task.split === "train");
  const nonTrainIds = new Set(TASKS.filter((task) => task.split !== "train").map((task) => task.taskId));
  if (train.length !== 48 || train.some((task) => task.split !== "train")) throw new Error("SFT dataset requires exactly the 48 train tasks");
  if (train.some((task) => nonTrainIds.has(task.taskId))) throw new Error("SFT task-id contamination detected");
  const records = train.map((task) => {
    const { handle, obs } = reset(task.taskId);
    const leakage = auditObservationLeakage(obs, task);
    if (leakage.length) throw new Error(`observation leakage for ${task.taskId}: ${leakage.join("; ")}`);
    const messages = obs.messages.map((message) => ({ role: message.role, content: message.content }));
    for (const [callIndex, call] of task.oracle.entries()) {
      const beforeLength = obs.messages.length;
      messages.push(assistantToolMessage(call, callIndex + 1));
      const result = step(handle, call);
      const toolMessage = result.obs.messages.slice(beforeLength).findLast((message) => message.role === "tool");
      if (!toolMessage) throw new Error(`oracle step did not append a tool result for ${task.taskId}`);
      messages.push({ role: "tool", tool_call_id: `oracle_${callIndex + 1}`, content: toolMessage.content });
    }
    messages.push({ role: "assistant", content: "Done." });
    return {
      messages,
      tools: TOOLS,
    };
  });
  return records;
}

export function tokenEstimate(records) {
  return Math.ceil(JSON.stringify(records).length / 4);
}

function arg(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const output = resolve(arg(process.argv.slice(2), "--output", "outputs/automationbench-gemma-sft-train.jsonl"));
  const records = buildSftRecords();
  const manifest = {
    task_ids: TASKS.filter((task) => task.split === "train").map((task) => task.taskId),
    harness_sha256: fixtureSha256(),
    split_sha256: splitSha256("train"),
    record_count: records.length,
    token_estimate: tokenEstimate(records),
  };
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output, manifest: `${output}.manifest.json`, records: records.length, estimated_tokens: manifest.token_estimate, train_only: true }));
}
