#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { finish, partialCredit, reset, step } from "../../../dist/automationbench-offline.js";
import { splitSha256, taskBand, taskPool } from "../src/wl07-fixture.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
if (!model) throw new Error("--model is required");
const split = argValue("--split", "dev");
const limit = Number(argValue("--limit", "0")) || 0;
const stride = Number(argValue("--stride", "1")) || 1;
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "14"));
const temperature = Number(argValue("--temperature", "0"));
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const maxTokens = Number(argValue("--max-tokens", "1024"));
const requestTimeoutMs = Number(argValue("--request-timeout-ms", "180000"));
const episodeWallClockMs = Number(argValue("--episode-wall-clock-ms", "900000"));
const maxRetries = Number(argValue("--max-retries", "2"));
const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
const outPath = argValue("--out");
const captureCompletions = argValue("--capture-completions");
const frozenHoldout = argValue("--frozen-holdout");
const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

const pool = taskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const strided = pool.filter((_task, index) => index % stride === 0);
const tasks = limit > 0 ? strided.slice(0, limit) : strided;
const system = [
  "You operate business apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

function parseAction(text) {
  const visible = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "no JSON object in reply" };
  let decoded;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const name = decoded.tool ?? decoded.name;
  if (name === "finish") return { finish: true };
  if (name !== "api_search" && name !== "api_fetch") return { error: "unknown tool" };
  const args = typeof decoded.arguments === "string" ? JSON.parse(decoded.arguments) : decoded.arguments ?? {};
  return { action: { name, arguments: args } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function chat(messages, attempt = 0) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      if ([408, 409, 429].includes(response.status) || response.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(2000 * 2 ** attempt);
          return chat(messages, attempt + 1);
        }
      }
      throw new Error(`chat failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const payload = await response.json();
    return { text: payload.choices?.[0]?.message?.content ?? "", promptTokens: payload.usage?.prompt_tokens ?? 0, completionTokens: payload.usage?.completion_tokens ?? 0 };
  } catch (cause) {
    if (attempt < maxRetries && (cause?.name === "AbortError" || cause?.name === "TimeoutError" || cause?.name === "TypeError")) {
      await sleep(2000 * 2 ** attempt);
      return chat(messages, attempt + 1);
    }
    throw cause;
  }
}

async function runTask(task) {
  const { handle } = reset(task.taskId);
  const episodeStarted = Date.now();
  const messages = [{ role: "system", content: system }, { role: "user", content: task.prompt }];
  let malformed = 0;
  let consecutiveMalformed = 0;
  let ended = "budget";
  let error = null;
  let promptTokens = 0;
  let completionTokens = 0;
  const completionMessages = [];
  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      if (Date.now() - episodeStarted >= episodeWallClockMs) {
        throw new Error(`episode wall-clock cap exceeded (${episodeWallClockMs} ms)`);
      }
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      completionMessages.push(reply.text || "");
      const parsed = parseAction(reply.text);
      if (parsed.finish) {
        ended = "finish";
        finish(handle);
        break;
      }
      if (parsed.error) {
        malformed += 1;
        consecutiveMalformed += 1;
        if (consecutiveMalformed >= malformedTolerance) {
          ended = "malformed";
          finish(handle);
          break;
        }
        messages.push({ role: "user", content: `rejected: ${parsed.error}. Reply with one JSON tool object.` });
        continue;
      }
      consecutiveMalformed = 0;
      const result = step(handle, parsed.action);
      messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
    }
    if (!handle.done) finish(handle);
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }
  const row = {
    task_id: task.taskId,
    family: task.taskId.replace(/^wl07-email-orchestration-/, "").replace(/-\d{2}$/, ""),
    band: taskBand(task),
    split: task.split,
    score: error ? null : partialCredit(handle),
    steps: handle.step,
    ended,
    malformed,
    forbidden_effects: handle.forbiddenEffects.length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    error,
  };
  if (captureCompletions) row.completion_messages = completionMessages;
  return row;
}

const started = Date.now();
const rows = [];
let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
  while (cursor < tasks.length) {
    rows.push(await runTask(tasks[cursor++]));
    process.stderr.write(`\r${rows.length}/${tasks.length} done`);
  }
});
await Promise.all(workers);
process.stderr.write("\n");

const scored = rows.filter((row) => typeof row.score === "number");
const mean = (values) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const byBand = {};
for (const row of scored) (byBand[row.band] ??= []).push(row.score);
const report = {
  model,
  split,
  fixture: "wl07-email-orchestration-offline-v1",
  split_sha256: splitSha256(split),
  pool_size: pool.length,
  sampled: tasks.length,
  scored: scored.length,
  errors: rows.length - scored.length,
  mean_score: mean(scored.map((row) => row.score)),
  exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
  zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
  mean_by_band: Object.fromEntries(Object.entries(byBand).map(([band, values]) => [band, mean(values)])),
  over_acting_episodes: rows.filter((row) => row.forbidden_effects > 0).length,
  forbidden_writes: rows.reduce((sum, row) => sum + row.forbidden_effects, 0),
  malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
  prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
  completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
  wall_clock_s: Math.round((Date.now() - started) / 1000),
  rows: rows.sort((a, b) => a.task_id.localeCompare(b.task_id)),
};
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
const { rows: _rows, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
