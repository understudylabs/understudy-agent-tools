#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { finish, parseToolCalls, reset, step, taskPool, validateEvalRows } from "../dist/automationbench-offline.js";

const tools = [
  {
    type: "function",
    function: {
      name: "api_search",
      description: "Read-only endpoint discovery. Args: {query: string, top_k?: number}.",
      parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "number" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "api_fetch",
      description: "Apply one API call. Args: {method: string, url: string, body?: object}.",
      parameters: { type: "object", properties: { method: { type: "string" }, url: { type: "string" }, body: { type: "object" } }, required: ["method", "url"] },
    },
  },
];

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const baseUrl = args["base-url"] ?? process.env.OPENAI_BASE_URL;
const apiKey = args["api-key"] ?? process.env.OPENAI_API_KEY;
const model = args.model ?? process.env.OPENAI_MODEL;
const output = args.output ?? "experiments/modal-nemotron-lora/rows.jsonl";
const summaryOutput = args.summary ?? output.replace(/\.jsonl$/, ".summary.json");
const split = args.split ?? "train";
const concurrency = Number(args.concurrency ?? 4);
if (!baseUrl || !model) throw new Error("--base-url and --model are required");
if (split !== "train" && split !== "dev") throw new Error("only train and dev are permitted");

async function request(payload) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`endpoint ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function runTask(task) {
  const started = Date.now();
  const { handle, obs: initial } = reset(task.taskId, 7);
  let obs = initial;
  let finishReason = "step_limit";
  let errors = [];
  for (let turn = 0; turn < 12; turn += 1) {
    try {
      const response = await request({ model, messages: obs.messages, tools, tool_choice: "auto", temperature: 0, max_tokens: 512 });
      const message = response.choices?.[0]?.message ?? {};
      const calls = parseToolCalls(message);
      if (calls.length === 0) {
        finishReason = response.choices?.[0]?.finish_reason ?? "finish";
        break;
      }
      const result = step(handle, calls[0]);
      obs = result.obs;
      if (result.done) {
        finishReason = "environment_done";
        break;
      }
    } catch (error) {
      errors.push(String(error));
      break;
    }
  }
  const terminal = finish(handle);
  return {
    schema_version: "understudy.eval_result.v1",
    run_id: `modal-vllm-${model}-${split}`,
    task_id: task.taskId,
    split: task.split,
    score: terminal.reward,
    status: errors.length ? "error" : "ok",
    model,
    route: "modal-vllm-openai-compatible",
    cost: { usd: null, basis: "modal-gpu-usage-recorded-separately" },
    benchmark_id: "automationbench-simple-api-offline",
    subscores: { forbidden_effects: terminal.info.forbidden_effects ?? [], steps: handle.step },
    provenance: { reset_seed: 7, endpoint: baseUrl, finish_reason: finishReason },
    latency_ms: Date.now() - started,
    errors,
  };
}

const rows = [];
const tasks = taskPool({ split });
for (let i = 0; i < tasks.length; i += concurrency) {
  rows.push(...await Promise.all(tasks.slice(i, i + concurrency).map(runTask)));
}
const validationErrors = validateEvalRows(rows);
if (validationErrors.length) throw new Error(validationErrors.join("\n"));
await mkdir(dirname(output), { recursive: true });
const rowsText = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
await writeFile(output, rowsText);
const rowsSha256 = createHash("sha256").update(rowsText).digest("hex");
const summary = {
  schema_version: "understudy.eval_summary.v1",
  artifact: { path: output, sha256: rowsSha256 },
  model,
  split,
  rows: rows.length,
  mean_partial_credit: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
  strict_finish_rate: rows.filter((row) => row.score === 1 && row.status === "ok").length / rows.length,
  validationErrors,
};
const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
await writeFile(summaryOutput, summaryText);
const summarySha256 = createHash("sha256").update(summaryText).digest("hex");
console.log(JSON.stringify({ output, summaryOutput, rowsSha256, summarySha256, model, split, rows: rows.length, validationErrors }, null, 2));
