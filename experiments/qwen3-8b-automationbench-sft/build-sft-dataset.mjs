#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  oraclePolicy,
  reset,
  step,
  TASKS,
} from "../../dist/automationbench-offline.js";

const SYSTEM_MESSAGE =
  "You operate business apps through api_search and api_fetch. Make the smallest change that satisfies the request. " +
  "Accomplish the user's request by calling the provided tools, and stop calling tools when you are done. /no_think";

function openAiTools(observation) {
  const descriptions = new Map(observation.tools.map((tool) => [tool.name, tool.description]));
  return [
    {
      type: "function",
      function: {
        name: "api_search",
        description: descriptions.get("api_search"),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            top_k: { type: "integer" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "api_fetch",
        description: descriptions.get("api_fetch"),
        parameters: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            body: { type: "object" },
          },
          required: ["method", "url"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function parseArgs(argv) {
  const options = {
    out: fileURLToPath(new URL("./sft-train.jsonl", import.meta.url)),
    preview: fileURLToPath(new URL("./sft-train-preview.json", import.meta.url)),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") options.out = resolve(argv[++index]);
    else if (argv[index] === "--preview") options.preview = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const trainTasks = TASKS.filter((task) => task.split === "train");
const examples = [];

for (const task of trainTasks) {
  if (task.split !== "train") throw new Error(`refusing non-train task ${task.taskId}`);
  const { handle, obs } = reset(task.taskId);
  const messages = [
    { role: "system", content: SYSTEM_MESSAGE },
    { role: "user", content: task.prompt },
  ];
  const tools = openAiTools(obs);
  const policy = oraclePolicy(task.taskId);
  let current = obs;
  let callNumber = 0;
  for (;;) {
    const call = policy(current);
    if (!call) break;
    callNumber += 1;
    const callId = `call_${callNumber}`;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      }],
    });
    const result = step(handle, call);
    current = result.obs;
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: current.messages.at(-1)?.content ?? "",
    });
    if (result.done) break;
  }
  messages.push({ role: "assistant", content: "" });
  const example = { messages, tools };
  if (task.split !== "train") throw new Error(`emitted non-train task ${task.taskId}`);
  examples.push(example);
}

const jsonl = `${examples.map((example) => JSON.stringify(example)).join("\n")}\n`;
const outputPath = resolve(options.out);
const previewPath = resolve(options.preview);
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(previewPath), { recursive: true });
await writeFile(outputPath, jsonl);
await writeFile(previewPath, `${JSON.stringify(examples.slice(0, 2), null, 2)}\n`);

const totalChars = jsonl.length;
console.log(`lines: ${examples.length}`);
console.log(`total chars: ${totalChars}`);
console.log(`rough tokens: ${Math.ceil(totalChars / 4)}`);
console.log(`dataset: ${outputPath}`);
console.log(`preview: ${previewPath}`);
