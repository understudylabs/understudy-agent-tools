#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  fixtureSha256,
  finish,
  parseToolCalls,
  reset,
  splitSha256,
  step,
  taskBands,
  taskPool,
} from "../../dist/automationbench-offline.js";

const DEFAULT_SYSTEM =
  "You operate business apps through api_search and api_fetch. Make the smallest change that satisfies the request. " +
  "Accomplish the user's request by calling the provided tools, and stop calling tools when you are done.";
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_CONCURRENCY = 4;
const MAX_RETRIES = 5;

function usage() {
  console.error(`Usage: node experiments/qwen3-8b-automationbench-sft/run-eval.mjs
  --split train|dev|holdout --model <id> --base-url <url>
  [--api-key-env <ENVVAR>] [--frozen-holdout-sha256 <sha>]
  [--out <path.json>] [--concurrency N] [--max-steps N]
  [--temperature N] [--no-think|--think] [--reasoning-effort <value>]`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    split: null,
    model: null,
    baseUrl: null,
    apiKeyEnv: "FIREWORKS_API_KEY",
    frozenHoldoutSha256: undefined,
    out: null,
    concurrency: DEFAULT_CONCURRENCY,
    maxSteps: Number(process.env.MAX_STEPS ?? DEFAULT_MAX_STEPS),
    temperature: 0,
    noThink: true,
    reasoningEffort: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-think") {
      options.noThink = true;
      continue;
    }
    if (arg === "--think") {
      options.noThink = false;
      continue;
    }
    const name = arg.startsWith("--") ? arg.slice(2) : null;
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) usage();
      return value;
    };
    if (name === "split") options.split = next();
    else if (name === "model") options.model = next();
    else if (name === "base-url") options.baseUrl = next();
    else if (name === "api-key-env") options.apiKeyEnv = next();
    else if (name === "frozen-holdout-sha256") options.frozenHoldoutSha256 = next();
    else if (name === "out") options.out = next();
    else if (name === "concurrency") options.concurrency = Number(next());
    else if (name === "max-steps") options.maxSteps = Number(next());
    else if (name === "temperature") options.temperature = Number(next());
    else if (name === "reasoning-effort") options.reasoningEffort = next();
    else usage();
  }
  if (!["train", "dev", "holdout"].includes(options.split) ||
      !options.model || !options.baseUrl ||
      !Number.isInteger(options.concurrency) || options.concurrency < 1 ||
      !Number.isInteger(options.maxSteps) || options.maxSteps < 1 ||
      !Number.isFinite(options.temperature)) usage();
  if (options.split === "holdout" && !options.frozenHoldoutSha256) usage();
  return options;
}

function endpointUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

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

function resultContent(observation) {
  return observation.messages.at(-1)?.content ?? "";
}

function backoffMs(attempt) {
  return 250 * (2 ** attempt);
}

async function requestChat({ url, apiKey, payload }) {
  let retries = 0;
  let requests = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      requests += 1;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return { body: await response.json(), retries, requests };
      if (response.status !== 429 && response.status < 500) {
        const text = await response.text();
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        error.retryable = false;
        error.requests = requests;
        error.retries = retries;
        throw error;
      }
      if (attempt === MAX_RETRIES - 1) {
        const error = new Error(`HTTP ${response.status}: retry limit exhausted`);
        error.requests = requests;
        error.retries = retries;
        throw error;
      }
    } catch (error) {
      if (error?.retryable === false) throw error;
      if (attempt === MAX_RETRIES - 1) {
        error.requests = requests;
        error.retries = retries;
        throw error;
      }
    }
    if (attempt < MAX_RETRIES - 1) retries += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, backoffMs(attempt)));
  }
  throw new Error("request retry loop exhausted");
}

async function evaluateTask(task, options, bands, tools, url, apiKey) {
  const started = performance.now();
  const { handle, obs: initial } = reset(task.taskId);
  const system = `${DEFAULT_SYSTEM}${options.noThink ? " /no_think" : ""}`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: task.prompt },
  ];
  let observation = initial;
  let malformed = 0;
  let error = null;
  let retries = 0;
  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const toolCallNames = [];

  try {
    for (let currentStep = 0; currentStep < options.maxSteps && !handle.done; currentStep += 1) {
      const payload = {
        model: options.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: options.temperature,
        ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
      };
      let response;
      try {
        response = await requestChat({ url, apiKey, payload });
      } catch (requestError) {
        requests += Number(requestError?.requests ?? 0);
        retries += Number(requestError?.retries ?? 0);
        error = requestError instanceof Error ? requestError.message : String(requestError);
        break;
      }
      requests += response.requests;
      retries += response.retries;
      const usage = response.body?.usage ?? {};
      promptTokens += Number(usage.prompt_tokens ?? 0);
      completionTokens += Number(usage.completion_tokens ?? 0);
      const message = response.body?.choices?.[0]?.message;
      if (!message || typeof message !== "object") {
        error = "response has no assistant message";
        break;
      }
      if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
        malformed += 1;
        error = "assistant tool_calls field is not an array";
        observation = finish(handle).obs;
        break;
      }
      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      messages.push(message);
      if (rawToolCalls.length === 0) {
        observation = finish(handle).obs;
        break;
      }
      let calls;
      try {
        calls = parseToolCalls({ tool_calls: rawToolCalls });
      } catch (parseError) {
        malformed += 1;
        error = parseError instanceof Error ? parseError.message : String(parseError);
        observation = finish(handle).obs;
        break;
      }
      if (calls.length !== rawToolCalls.length) {
        malformed += 1;
        error = "parsed tool-call count did not match response";
        observation = finish(handle).obs;
        break;
      }
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index];
        if (!tools.some((tool) => tool.function.name === call.name)) {
          malformed += 1;
          error = `tool call names unknown tool: ${call.name}`;
          observation = finish(handle).obs;
          break;
        }
        toolCallNames.push(call.name);
        const result = step(handle, call);
        observation = result.obs;
        messages.push({
          role: "tool",
          tool_call_id: rawToolCalls[index]?.id ?? `call_${currentStep + 1}_${index + 1}`,
          content: resultContent(observation),
        });
        if (result.done) break;
      }
      if (error || handle.done) break;
    }
    if (!handle.done) observation = finish(handle).obs;
  } catch (unexpectedError) {
    error = unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError);
    if (!handle.done) observation = finish(handle).obs;
  }

  const reward = handle.done ? (finish(handle).reward) : 0;
  return {
    task_id: task.taskId,
    split: task.split,
    band: bands[task.taskId.split("-").slice(2, -1).join("-")] ?? "unknown",
    reward,
    steps: handle.step,
    malformed,
    forbidden_effects: [...handle.forbiddenEffects],
    tool_call_names: toolCallNames,
    error,
    _requests: requests,
    _retries: retries,
    _prompt_tokens: promptTokens,
    _completion_tokens: completionTokens,
    _wall_ms: performance.now() - started,
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

const options = parseArgs(process.argv.slice(2));
const tasks = taskPool({
  split: options.split,
  ...(options.frozenHoldoutSha256 ? { frozenHoldoutSha256: options.frozenHoldoutSha256 } : {}),
});
const bandsBySlug = taskBands();
const bands = Object.fromEntries(Object.entries(bandsBySlug).map(([slug, band]) => [slug, band]));
const { obs } = reset(tasks[0].taskId);
const tools = openAiTools(obs);
const url = endpointUrl(options.baseUrl);
const apiKey = process.env[options.apiKeyEnv];
const runStarted = performance.now();
const results = await mapConcurrent(
  tasks,
  options.concurrency,
  (task) => evaluateTask(task, options, bands, tools, url, apiKey),
);
const wallSeconds = (performance.now() - runStarted) / 1000;
const perTask = results.map(({ _requests, _retries, _prompt_tokens, _completion_tokens, _wall_ms, ...row }) => row);
const total = (field) => results.reduce((sum, row) => sum + row[field], 0);
const output = {
  model: options.model,
  split: options.split,
  n_tasks: tasks.length,
  mean_reward: perTask.reduce((sum, row) => sum + row.reward, 0) / Math.max(perTask.length, 1),
  per_task: perTask,
  totals: {
    prompt_tokens: total("_prompt_tokens"),
    completion_tokens: total("_completion_tokens"),
    requests: total("_requests"),
    wall_seconds: wallSeconds,
    retries: total("_retries"),
    malformed_tasks: perTask.filter((row) => row.malformed > 0).length,
  },
  fixture_sha256: fixtureSha256(),
  split_sha256: splitSha256(options.split),
  generated_at: new Date().toISOString(),
};
if (options.out) {
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}
console.log(
  `${output.model} ${output.split}: ${output.mean_reward.toFixed(4)} mean reward ` +
  `(${output.n_tasks} tasks, ${output.totals.requests} requests, ${output.totals.malformed_tasks} malformed)`,
);
