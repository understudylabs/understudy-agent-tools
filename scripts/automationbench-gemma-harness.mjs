#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  AUTOMATIONBENCH_SUBSET,
  TASKS,
  auditObservationLeakage,
  fixtureSha256,
  finish,
  oraclePolicy,
  partialCredit,
  parseToolCalls,
  reset,
  sentinelPolicy,
  step,
  splitSha256,
  taskPool,
  validateEvalRows,
} from "../dist/automationbench-offline.js";

export const MAX_STEPS = 12;
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "api_search",
      description: "Read-only endpoint discovery.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, top_k: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "api_fetch",
      description: "Apply one API call.",
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

function errorMessage(message) {
  return JSON.stringify({ error: message });
}

function assistantToolMessage(calls) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call, index) => ({
      id: call.id ?? `call_${index + 1}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
}

function observationMessages(obs) {
  return obs.messages.map((message) => ({ role: message.role, content: message.content }));
}

function toolResultContent(obs, beforeLength) {
  const message = obs.messages.slice(beforeLength).findLast((entry) => entry.role === "tool");
  if (!message) throw new Error("evaluator step did not append a tool message");
  return message.content;
}

/**
 * Drive one episode through the authoritative evaluator. `respond` receives
 * the current OpenAI-style messages and returns an assistant message.
 */
export async function runEpisode(taskId, { respond, policy, maxSteps = MAX_STEPS, malformedLimit = 3 } = {}) {
  if (typeof respond !== "function" && typeof policy !== "function") throw new Error("runEpisode requires respond or policy");
  const { handle, obs: initial } = reset(taskId);
  const task = TASKS.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`unknown task_id: ${taskId}`);
  const leakage = auditObservationLeakage(initial, task);
  if (leakage.length) throw new Error(`observation leakage for ${taskId}: ${leakage.join("; ")}`);
  const messages = observationMessages(initial);
  let obs = initial;
  let malformedToolCalls = 0;
  let consecutiveMalformed = 0;
  let noToolCallStops = 0;
  let unknownTool = 0;
  let stepLimitTermination = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let wallTimeMs = 0;
  const finishReasons = [];
  let truncatedResponses = 0;
  let terminal;

  while (!handle.done && handle.step < maxSteps) {
    const started = Date.now();
    let assistant;
    let usage;
    if (policy) {
      const action = policy(obs);
      assistant = action ? assistantToolMessage([action]) : { role: "assistant", content: "" };
    } else {
      const response = await respond(messages);
      assistant = response?.choices?.[0]?.message ?? response?.message ?? response;
      usage = response?.usage;
      const finishReason = response?.choices?.[0]?.finish_reason ?? null;
      finishReasons.push(finishReason);
      if (finishReason === "length") truncatedResponses += 1;
    }
    wallTimeMs += Date.now() - started;
    promptTokens += Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
    completionTokens += Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
    if (!assistant || typeof assistant !== "object") assistant = { role: "assistant", content: "" };
    messages.push({ ...assistant });

    let calls;
    try {
      calls = parseToolCalls(assistant);
    } catch (error) {
      malformedToolCalls += 1;
      consecutiveMalformed += 1;
      const toolCallId = Array.isArray(assistant.tool_calls) ? assistant.tool_calls.find((call) => call && typeof call.id === "string")?.id : null;
      if (toolCallId) {
        messages.push({ role: "tool", tool_call_id: toolCallId, content: errorMessage(`malformed tool call: ${error.message}`) });
      } else {
        messages.push({ role: "user", content: errorMessage(`malformed tool call: ${error.message}`) });
      }
      if (consecutiveMalformed >= malformedLimit) break;
      continue;
    }
    if (calls.length === 0) {
      noToolCallStops += 1;
      break;
    }
    consecutiveMalformed = 0;
    for (const [callIndex, call] of calls.entries()) {
      if (call.name !== "api_search" && call.name !== "api_fetch") unknownTool += 1;
      const beforeLength = obs.messages.length;
      const result = step(handle, call);
      obs = result.obs;
      const toolCallId = assistant.tool_calls?.[callIndex]?.id ?? `call_${handle.step}_${callIndex + 1}`;
      messages.push({ role: "tool", tool_call_id: toolCallId, content: toolResultContent(obs, beforeLength) });
      if (result.done) break;
    }
    if (handle.done) break;
  }
  stepLimitTermination = handle.step >= maxSteps;
  if (!handle.done) {
    terminal = finish(handle);
  } else {
    terminal = { reward: partialCredit(handle) };
  }
  return {
    taskId,
    split: task.split,
    reward: terminal.reward,
    steps: handle.step,
    forbiddenEffects: [...handle.forbiddenEffects],
    leakage,
    messages,
    stats: { malformed_tool_calls: malformedToolCalls, no_tool_call_stops: noToolCallStops, unknown_tool: unknownTool, step_limit_terminations: stepLimitTermination ? 1 : 0, truncated_responses: truncatedResponses, finish_reasons: finishReasons, prompt_tokens: promptTokens, completion_tokens: completionTokens, wall_time_ms: wallTimeMs },
  };
}

async function requestJson(url, body, { apiKey, timeoutMs, retries }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: controller.signal });
      if (response.ok) return await response.json();
      const text = await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`provider ${response.status}: ${text.slice(0, 300)}`);
      lastError = new Error(`provider ${response.status}: ${text.slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 2 ** attempt));
  }
  throw lastError;
}

export async function runModelSplit({ split, frozenHoldoutSha256, model, baseUrl = "https://api.fireworks.ai/inference", apiKey = process.env.FIREWORKS_API_KEY, concurrency = 4, timeoutMs = 60_000, retries = 3, seed = 7, maxTokens = 512, thinking = null, extraBody = {}, dryRun = false, runId = `automationbench-${Date.now()}` }) {
  if (!model) throw new Error("--model is required for model runs");
  const pool = taskPool({ split, frozenHoldoutSha256 });
  const requestBody = (messages) => ({
    ...extraBody,
    model,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0,
    seed,
    max_tokens: maxTokens,
    ...(thinking !== null && extraBody?.reasoning_effort === undefined ? { reasoning_effort: thinking } : {}),
  });
  if (dryRun) {
    const { obs } = reset(pool[0].taskId);
    return { dryRun: true, taskId: pool[0].taskId, requestBody: requestBody(observationMessages(obs)) };
  }
  if (!apiKey) throw new Error("FIREWORKS_API_KEY is required for model runs");
  const results = [];
  let cursor = 0;
  const respond = (messages) => requestJson(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, requestBody(messages), { apiKey, timeoutMs, retries });
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= pool.length) return;
      const task = pool[index];
      try {
        const started = Date.now();
        const result = await runEpisode(task.taskId, { respond });
        result.stats.wall_time_ms = Date.now() - started;
        results[index] = { ...result, model, route: "fireworks-openai-compatible" };
      } catch (error) {
        results[index] = { taskId: task.taskId, split: task.split, reward: null, steps: 0, forbiddenEffects: [], leakage: [], model, route: "fireworks-openai-compatible", error: error.message, stats: { malformed_tool_calls: 0, no_tool_call_stops: 0, unknown_tool: 0, step_limit_terminations: 0, truncated_responses: 0, finish_reasons: [], prompt_tokens: 0, completion_tokens: 0, wall_time_ms: 0 } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pool.length) }, () => worker()));
  const rows = results.map((result) => ({
    schema_version: "understudy.eval_result.v1",
    run_id: runId,
    task_id: result.taskId,
    split: result.split,
    score: result.reward,
    status: result.error ? "error" : "ok",
    model,
    route: result.route,
    cost: { usd: null, basis: "provider-response-cost-not-returned" },
    benchmark_id: AUTOMATIONBENCH_SUBSET.benchmark_id,
    subscores: { forbidden_effects: result.forbiddenEffects.length, steps: result.steps },
    provenance: { harness_sha256: fixtureSha256(), split_sha256: splitSha256(split), artifact_refs: [`fixture://${AUTOMATIONBENCH_SUBSET.fixture_id}`] },
    prompt_tokens: result.stats.prompt_tokens,
    completion_tokens: result.stats.completion_tokens,
    latency_ms: result.stats.wall_time_ms,
    malformed_tool_calls: result.stats.malformed_tool_calls,
    no_tool_call_stops: result.stats.no_tool_call_stops,
    unknown_tool: result.stats.unknown_tool,
    step_limit_terminations: result.stats.step_limit_terminations,
    truncated_responses: result.stats.truncated_responses,
    finish_reasons: result.stats.finish_reasons,
    error: result.error ?? null,
  }));
  const errors = validateEvalRows(rows);
  if (errors.length) throw new Error(`invalid eval rows: ${errors.join("; ")}`);
  return { rows, episodes: results, summary: summarizeResults(results) };
}

export function summarizeResults(results) {
  const totals = { malformed_tool_calls: 0, no_tool_call_stops: 0, unknown_tool: 0, step_limit_terminations: 0, truncated_responses: 0, prompt_tokens: 0, completion_tokens: 0, wall_time_ms: 0 };
  for (const result of results) {
    for (const key of Object.keys(totals)) totals[key] += Number(result.stats?.[key] ?? 0);
  }
  return {
    task_count: results.length,
    mean_reward: results.length ? results.reduce((sum, result) => sum + (typeof result.reward === "number" ? result.reward : 0), 0) / results.length : 0,
    errored_tasks: results.filter((result) => result.error).length,
    forbidden_effect_tasks: results.filter((result) => result.forbiddenEffects?.length > 0).length,
    ...totals,
  };
}

export async function runSanity() {
  const taskIds = taskPool({ split: "train" }).slice(0, 3).concat(taskPool({ split: "dev" }).slice(0, 3)).map((task) => task.taskId);
  const scores = {};
  for (const [name, makePolicy] of [["oracle", oraclePolicy], ["sentinel", () => sentinelPolicy()]]) {
    const episodes = [];
    for (const taskId of taskIds) episodes.push(await runEpisode(taskId, { policy: makePolicy(taskId) }));
    scores[name] = { count: episodes.length, mean_reward: episodes.reduce((sum, episode) => sum + episode.reward, 0) / episodes.length, episodes };
  }
  if (scores.oracle.mean_reward !== 1 || scores.sentinel.mean_reward !== 0) throw new Error(`sanity gate failed: oracle=${scores.oracle.mean_reward}, sentinel=${scores.sentinel.mean_reward}`);
  return scores;
}

function arg(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const output = resolve(arg(args, "--output", `outputs/automationbench-gemma-${Date.now()}.jsonl`));
  if (args.includes("--sanity")) {
    const result = await runSanity();
    console.log(JSON.stringify({ oracle_mean_reward: result.oracle.mean_reward, sentinel_mean_reward: result.sentinel.mean_reward, tasks: result.oracle.count }));
  } else {
    const split = arg(args, "--split", "train");
    const frozenHoldoutSha256 = arg(args, "--frozen-holdout-sha256");
    const extraBodyText = arg(args, "--extra-body", "{}");
    let extraBody;
    try {
      extraBody = JSON.parse(extraBodyText);
    } catch (error) {
      throw new Error(`--extra-body must be valid JSON: ${error.message}`);
    }
    if (!extraBody || typeof extraBody !== "object" || Array.isArray(extraBody)) throw new Error("--extra-body must be a JSON object");
    const result = await runModelSplit({ split, frozenHoldoutSha256, model: arg(args, "--model"), baseUrl: arg(args, "--base-url", "https://api.fireworks.ai/inference"), concurrency: Number(arg(args, "--concurrency", "4")), timeoutMs: Number(arg(args, "--timeout-ms", "60000")), retries: Number(arg(args, "--retries", "3")), maxTokens: Number(arg(args, "--max-tokens", "512")), thinking: arg(args, "--thinking"), extraBody, dryRun: args.includes("--dry-run"), runId: arg(args, "--run-id", `automationbench-${randomUUID()}`) });
    if (result.dryRun) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, result.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(`${output}.summary.json`, `${JSON.stringify(result.summary, null, 2)}\n`);
    console.log(JSON.stringify({ output, summary: `${output}.summary.json`, ...result.summary }));
  }
}
