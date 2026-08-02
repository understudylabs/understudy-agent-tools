#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TASKS, taskPool, reset, step, finish, partialCredit, fixtureSha256, splitSha256, oraclePolicy, sentinelPolicy, rollout, taskBands, validateEvalRows } from "../dist/automationbench-offline.js";

const PROVIDERS = {
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1/chat/completions", keyEnv: "FIREWORKS_API_KEY", route: "fireworks-serverless" },
  understudy: { baseUrl: "https://api.understudylabs.com/v1/chat/completions", keyEnv: "UNDERSTUDY_API_KEY", route: "understudy-gateway" },
  openai: { baseUrl: "https://api.openai.com/v1/chat/completions", keyEnv: "OPENAI_API_KEY", route: "openai" },
  "understudy-anthropic": { baseUrl: "https://api.understudylabs.com/v1/messages", keyEnv: "UNDERSTUDY_API_KEY", route: "understudy-gateway-anthropic", wire: "anthropic-messages" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1/messages", keyEnv: "ANTHROPIC_API_KEY", route: "anthropic", wire: "anthropic-messages" },
};
const TOOL_DEFINITIONS = [
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
        properties: { method: { type: "string" }, url: { type: "string" }, body: { type: "object" } },
        required: ["method", "url"],
        additionalProperties: false,
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((tool) => tool.function.name));

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const result = args[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

function values(args, name) {
  return args.flatMap((arg, index) => (arg === name && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1].split(",") : []));
}

function numberValue(args, name, fallback) {
  const raw = value(args, name);
  if (raw == null) return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function parseArgs(args) {
  const splits = values(args, "--split");
  if (splits.length === 0) splits.push("dev");
  if (splits.some((splitName) => !["train", "dev"].includes(splitName))) throw new Error("--split accepts train or dev only; holdout is sealed");
  const mode = value(args, "--mode", "tools");
  if (!["tools", "json"].includes(mode)) throw new Error("--mode must be tools or json");
  const provider = value(args, "--provider", "fireworks");
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`--provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  return {
    model: value(args, "--model"),
    splits: [...new Set(splits)],
    provider,
    keyEnv: value(args, "--api-key-env", PROVIDERS[provider].keyEnv),
    baseUrl: value(args, "--base-url", PROVIDERS[provider].baseUrl),
    concurrency: numberValue(args, "--concurrency", 4) || 1,
    limit: numberValue(args, "--limit", null),
    maxTurns: numberValue(args, "--max-turns", 12) || 1,
    maxTokens: numberValue(args, "--max-tokens", 1536) || 1,
    temperature: Number(value(args, "--temperature", "0")),
    out: value(args, "--out", "automationbench-zeroshot-baseline.json"),
    mode,
    nameToolMessages: args.includes("--name-tool-messages"),
    omitTemperature: args.includes("--omit-temperature"),
    sanity: args.includes("--sanity"),
    probeTools: args.includes("--probe-tools"),
  };
}

function familyFor(taskId) {
  const parts = taskId.split("-");
  return parts.slice(2, -1).join("-");
}

function cleanJsonText(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function anthropicBody(config, messages) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const turns = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const text = String(message.content ?? "").trim();
    if (!text) continue;
    const previous = turns.at(-1);
    if (previous && previous.role === role) previous.content += `\n\n${text}`;
    else turns.push({ role, content: text });
  }
  const body = { model: config.model, max_tokens: config.maxTokens, messages: turns.map((turn) => ({ role: turn.role, content: [{ type: "text", text: turn.content }] })) };
  if (!config.omitTemperature) body.temperature = config.temperature;
  if (system) body.system = system;
  return body;
}

function fromAnthropic(parsed) {
  const content = (parsed.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: parsed.stop_reason === "max_tokens" ? "length" : "stop" }],
    usage: { prompt_tokens: parsed.usage?.input_tokens ?? 0, completion_tokens: parsed.usage?.output_tokens ?? 0 },
  };
}

async function request(config, messages, turn, options = {}) {
  const wire = PROVIDERS[config.provider].wire ?? "openai-chat";
  if (wire === "anthropic-messages") return requestAnthropic(config, messages, turn);
  const body = { model: config.model, messages, max_tokens: config.maxTokens };
  if (!config.omitTemperature) body.temperature = config.temperature;
  if (config.mode === "tools" || options.forceTools) body.tools = TOOL_DEFINITIONS;
  if (options.toolChoice) body.tool_choice = options.toolChoice;
  if (turn === 0) {
    console.log(`[request-shape] mode=${config.mode} keys=${Object.keys(body).join(",")} messages=${messages.length} tools=${body.tools?.length ?? 0}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response;
    try {
      response = await fetch(config.baseUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env[config.keyEnv] ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
      continue;
    }
    const raw = await response.text();
    if (response.status === 400 || response.status === 404) {
      const error = new Error(`provider HTTP ${response.status}: ${raw}`);
      error.fatalProvider = true;
      throw error;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`provider HTTP ${response.status}: ${raw}`);
      if (attempt === 4) throw lastError;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${raw}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`provider returned non-JSON response: ${raw}`);
    }
    if (turn === 0) console.log(`[response-shape] keys=${Object.keys(parsed).join(",")} choices=${parsed.choices?.length ?? 0} usage_keys=${Object.keys(parsed.usage ?? {}).join(",")}`);
    return parsed;
  }
  throw lastError ?? new Error("provider request failed");
}

async function requestAnthropic(config, messages, turn) {
  const body = anthropicBody(config, messages);
  if (turn === 0) console.log(`[request-shape] wire=anthropic-messages keys=${Object.keys(body).join(",")} messages=${body.messages.length}`);
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response;
    try {
      response = await fetch(config.baseUrl, {
        method: "POST",
        headers: { "x-api-key": process.env[config.keyEnv] ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
      continue;
    }
    const raw = await response.text();
    if (response.status === 400 || response.status === 404) {
      const error = new Error(`provider HTTP ${response.status}: ${raw}`);
      error.fatalProvider = true;
      throw error;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`provider HTTP ${response.status}: ${raw}`);
      if (attempt === 4) throw lastError;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${raw}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`provider returned non-JSON response: ${raw}`);
    }
    if (turn === 0) console.log(`[response-shape] wire=anthropic-messages stop_reason=${parsed.stop_reason} blocks=${parsed.content?.length ?? 0}`);
    return fromAnthropic(parsed);
  }
  throw lastError ?? new Error("provider request failed");
}

function malformedTool(config, name, reason) {
  const message = { role: "tool", tool_call_id: `malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`, content: JSON.stringify({ error: `malformed tool call${name ? ` for ${name}` : ""}: ${reason}` }) };
  if (config.nameToolMessages) message.name = name || "malformed_tool_call";
  return message;
}

function decodeNativeCall(call) {
  const name = call?.function?.name;
  if (!TOOL_NAMES.has(name)) return { error: `unknown tool name: ${name ?? "(missing)"}` };
  let args;
  try {
    args = JSON.parse(call?.function?.arguments ?? "{}");
  } catch {
    return { error: "arguments are not valid JSON" };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "arguments must be a JSON object" };
  return { name, arguments: args, id: call.id ?? `call-${Date.now()}` };
}

function decodeJsonCall(content) {
  const text = cleanJsonText(content);
  let candidate = null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const character = text[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "tool")) candidate = parsed;
          } catch {
            // Continue scanning for a later balanced object.
          }
          break;
        }
      }
    }
  }
  let parsed;
  if (candidate) {
    parsed = candidate;
  } else {
    if (!String(content ?? "").trim()) return { noCall: true };
    return { error: "assistant text is not a JSON object" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "JSON tool call must be an object" };
  if (!TOOL_NAMES.has(parsed.tool)) return { error: `unknown tool name: ${parsed.tool ?? "(missing)"}` };
  if (!parsed.arguments || typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments)) return { error: "arguments must be a JSON object" };
  return { name: parsed.tool, arguments: parsed.arguments, id: `json-${Date.now()}` };
}

async function runTask(config, task) {
  const { handle, obs: initial } = reset(task.taskId);
  const messages = initial.messages.map((message) => ({ role: message.role, content: message.content }));
  if (config.mode === "json") messages[0].content += ' If you reason, put that first, then end your response with exactly one JSON object of the form {"tool":"api_search"|"api_fetch","arguments":{...}}. Emit exactly one tool call per turn. When the requested change is already complete, reply with no JSON object to end the episode.';
  let malformed = 0;
  let consecutiveMalformedTurns = 0;
  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let error = null;
  const finishReasons = [];
  while (!handle.done && turns < config.maxTurns) {
    let response;
    try {
      response = await request(config, messages, turns);
    } catch (requestError) {
      error = errorMessage(requestError);
      if (requestError.fatalProvider) throw requestError;
      break;
    }
    turns += 1;
    finishReasons.push(response.choices?.[0]?.finish_reason ?? null);
    promptTokens += Number(response.usage?.prompt_tokens ?? 0);
    completionTokens += Number(response.usage?.completion_tokens ?? 0);
    const assistant = response.choices?.[0]?.message ?? {};
    const assistantMessage = { role: "assistant", content: assistant.content ?? "" };
    if (config.mode === "tools" && assistant.tool_calls) assistantMessage.tool_calls = assistant.tool_calls;
    messages.push(assistantMessage);
    const jsonContent = assistant.content || assistant.reasoning_content;
    const calls = config.mode === "tools" ? (Array.isArray(assistant.tool_calls) ? assistant.tool_calls.map(decodeNativeCall) : []) : [decodeJsonCall(jsonContent)];
    if (calls.length === 1 && calls[0].noCall) {
      finish(handle);
      break;
    }
    if (calls.length === 0) {
      finish(handle);
      break;
    }
    let turnMalformed = false;
    for (const call of calls) {
      if (call.error) {
        malformed += 1;
        turnMalformed = true;
        messages.push(malformedTool(config, "", call.error));
        continue;
      }
      if (handle.done) break;
      let result;
      try {
        result = step(handle, { name: call.name, arguments: call.arguments });
      } catch (stepError) {
        error = errorMessage(stepError);
        break;
      }
      const toolMessage = { role: "tool", tool_call_id: call.id, content: result.obs.messages.at(-1)?.content ?? "" };
      if (config.nameToolMessages) toolMessage.name = call.name;
      messages.push(toolMessage);
      if (result.done) break;
    }
    if (error || handle.done) break;
    consecutiveMalformedTurns = turnMalformed ? consecutiveMalformedTurns + 1 : 0;
    if (consecutiveMalformedTurns >= 3) {
      finish(handle);
      break;
    }
  }
  if (!handle.done) finish(handle);
  const score = partialCredit(handle);
  return {
    task_id: task.taskId,
    split: task.split,
    family: familyFor(task.taskId),
    band: taskBands()[familyFor(task.taskId)] ?? null,
    score,
    steps: handle.step,
    malformed,
    forbidden_effects: [...handle.forbiddenEffects],
    turns,
    finish_reason: finishReasons.at(-1) ?? null,
    finish_reasons: finishReasons,
    truncated: finishReasons.at(-1) === "length",
    error,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, consume));
  return results;
}

function rowFor(result, config, runId) {
  return {
    schema_version: "understudy.eval_result.v1",
    run_id: runId,
    task_id: result.task_id,
    split: result.split,
    score: result.score,
    status: result.error ? "error" : "ok",
    model: config.model,
    route: config.model.includes("#") ? `${config.provider}-dedicated` : PROVIDERS[config.provider].route,
    cost: { usd: null, basis: "provider-usage-not-priced" },
    benchmark_id: "automationbench-simple-api-offline",
    subscores: { forbidden_effects: result.forbidden_effects.length, steps: result.steps, malformed: result.malformed },
    provenance: { harness_sha256: fixtureSha256(), split_sha256: splitSha256(result.split), artifact_refs: ["fixture://automationbench-simple-api-offline-v1"] },
  };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.sanity) {
    const candidates = TASKS.filter((task) => task.split !== "holdout");
    const single = candidates.find((task) => taskBands()[familyFor(task.taskId)] === "single-write");
    const multi = candidates.find((task) => taskBands()[familyFor(task.taskId)] === "multi-write");
    if (!single || !multi) throw new Error("sanity tasks unavailable");
    const checks = [single, multi].flatMap((task) => [
      { task: task.taskId, policy: "oracle", result: rollout(task.taskId, oraclePolicy(task.taskId)) },
      { task: task.taskId, policy: "sentinel", result: rollout(task.taskId, sentinelPolicy()) },
    ]);
    console.log(JSON.stringify(checks.map(({ task, policy, result }) => ({ task, policy, reward: result.reward, steps: result.steps, forbidden_effects: result.forbiddenEffects })), null, 2));
    if (checks.some(({ policy, result }) => (policy === "oracle" ? result.reward !== 1 : result.reward !== 0))) process.exitCode = 1;
    return;
  }
  if (!config.model) throw new Error("--model is required unless --sanity is used");
  if (!process.env[config.keyEnv]) throw new Error(`${config.keyEnv} is required`);
  if (config.probeTools) {
    try {
      const probeResponse = await request({ ...config, mode: "tools" }, [
        { role: "system", content: "Return one tool call." },
        { role: "user", content: "Probe the available tool-call format." },
      ], 0, { toolChoice: "required" });
      const probeMessage = probeResponse.choices?.[0]?.message ?? {};
      console.log(`[probe-tools] status=success finish_reason=${probeResponse.choices?.[0]?.finish_reason ?? "null"} tool_calls=${probeMessage.tool_calls?.length ?? 0} content=${probeMessage.content ? "present" : "empty"}`);
    } catch (error) {
      console.log(`[probe-tools] ${errorMessage(error)}`);
    }
  }
  const tasks = config.splits.flatMap((split) => taskPool({ split })).slice(0, config.limit ?? Infinity);
  const runId = `automationbench-zeroshot-${Date.now()}`;
  let results;
  try {
    results = await mapConcurrent(tasks, config.concurrency, (task) => runTask(config, task));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }
  const rows = results.map((result) => rowFor(result, config, runId));
  const rowErrors = validateEvalRows(rows);
  if (rowErrors.length) console.error(`row validation errors:\n${rowErrors.join("\n")}`);
  const scores = results.map((result) => result.score);
  const summary = {
    n: results.length,
    mean_score: scores.reduce((sum, score) => sum + score, 0) / (scores.length || 1),
    exact_1_0_rate: scores.filter((score) => score === 1).length / (scores.length || 1),
    zero_rate: scores.filter((score) => score === 0).length / (scores.length || 1),
    total_prompt_tokens: results.reduce((sum, result) => sum + result.prompt_tokens, 0),
    total_completion_tokens: results.reduce((sum, result) => sum + result.completion_tokens, 0),
    mean_turns: results.reduce((sum, result) => sum + result.turns, 0) / (results.length || 1),
    malformed_total: results.reduce((sum, result) => sum + result.malformed, 0),
    errored_tasks: results.filter((result) => result.error).length,
    truncated_tasks: results.filter((result) => result.truncated).length,
    malformed_rate: results.reduce((sum, result) => sum + result.malformed, 0) / (results.reduce((sum, result) => sum + result.turns, 0) || 1),
  };
  const breakdown = (key) =>
    Object.fromEntries(
      [...new Set(results.map((result) => result[key]))].map((group) => {
        const grouped = results.filter((result) => result[key] === group);
        return [group, grouped.reduce((sum, result) => sum + result.score, 0) / grouped.length];
      }),
    );
  summary.by_band = breakdown("band");
  summary.by_family = breakdown("family");
  const deploymentSeparator = config.model.indexOf("#");
  const artifactModel = deploymentSeparator < 0 ? config.model : config.model.slice(0, deploymentSeparator);
  const deployment = deploymentSeparator < 0 ? null : config.model.slice(deploymentSeparator + 1);
  const artifact = {
    model: artifactModel,
    deployment,
    provider: config.provider,
    base_url: config.baseUrl,
    mode: config.mode,
    temperature: config.omitTemperature ? "omitted (rejected by model)" : config.temperature,
    name_tool_messages: config.nameToolMessages,
    split: config.splits,
    fixture_sha256: fixtureSha256(),
    split_sha256: Object.fromEntries(config.splits.map((split) => [split, splitSha256(split)])),
    generated_at: new Date().toISOString(),
    tasks: results,
    summary,
  };
  const out = resolve(config.out);
  await writeFile(out, `${JSON.stringify(artifact, null, 2)}\n`);
  const rowsPath = `${out}.rows.jsonl`;
  await writeFile(rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(`\nmodel             score   exact   zero   turns  malformed  errors`);
  console.log(`${config.model.padEnd(18)} ${summary.mean_score.toFixed(3)}   ${summary.exact_1_0_rate.toFixed(3)}  ${summary.zero_rate.toFixed(3)}  ${summary.mean_turns.toFixed(1)}    ${summary.malformed_total}          ${summary.errored_tasks}`);
  console.log(`artifact: ${out}`);
  console.log(`rows:     ${rowsPath}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
