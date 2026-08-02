#!/usr/bin/env node
/**
 * Score a model on the WL-OR slice of the synthetic workflow fixture, over an
 * OpenAI-compatible chat endpoint. One JSON tool call per turn; a malformed
 * emission is rejected, never repaired.
 *
 * The same script serves two jobs, so base and tuned runs share one code path:
 *   --samples 1 --temperature 0   scoring (dev, or holdout with the frozen hash)
 *   --samples N --temperature T   rollout mining on train, with transcripts
 *
 * Usage:
 *   node experiments/workload-orchestrator/slice-rollout.mjs \
 *     --model nemotron-3-nano --base-url http://localhost:8099/v1 \
 *     --split dev --out experiments/workload-orchestrator/artifacts/base-dev.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { finish, partialCredit, reset, step } from "../../dist/synthetic-workflow-offline.js";
import { SLICE, SLICE_BANDS, sliceCounts, slicePool, sliceSplitSha256 } from "./slice.mjs";

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
const samples = Number(argValue("--samples", "1")) || 1;
const temperature = Number(argValue("--temperature", "0"));
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "14"));
const maxTokens = Number(argValue("--max-tokens", "512"));
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const baseUrl = argValue("--base-url", "http://localhost:8099/v1");
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");
const keepTranscripts = process.argv.includes("--transcripts");
const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

const pool = slicePool(split, frozenHoldout ?? undefined);

const SYSTEM = [
  "You operate workflow apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/conversations"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

/** Strict parse: one JSON object naming a known tool. No repair, no salvage of prose. */
function parseAction(text) {
  const visible = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return { error: "no JSON object in reply" };
  let decoded;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
  if (typeof name !== "string") return { error: "reply has no tool name" };
  if (name === "finish") return { finish: true };
  if (name !== "api_search" && name !== "api_fetch") return { error: `unknown tool: ${name}` };
  let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return { error: "arguments are not valid JSON" };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "arguments must be an object" };
  return { action: { name, arguments: args } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(messages, attempt = 0) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(2000 * 2 ** attempt + Math.floor(Math.random() * 500));
      return chat(messages, attempt + 1);
    }
    throw new Error(`chat failed ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  return {
    text: payload.choices?.[0]?.message?.content ?? "",
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  };
}

async function runEpisode(task, sampleIndex) {
  const { handle } = reset(task.taskId);
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task.prompt },
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let malformed = 0;
  let consecutiveMalformed = 0;
  let ended = "budget";
  let error = null;
  const turns = [];

  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      const parsed = parseAction(reply.text);
      turns.push({ assistant: reply.text, rejected: parsed.error ?? null });
      if (parsed.finish) {
        ended = "finish";
        break;
      }
      if (parsed.error) {
        malformed += 1;
        consecutiveMalformed += 1;
        if (consecutiveMalformed >= malformedTolerance) {
          ended = "malformed";
          break;
        }
        const note = `rejected: ${parsed.error}. Reply with exactly one JSON tool object.`;
        messages.push({ role: "user", content: note });
        turns.at(-1).observation = note;
        continue;
      }
      consecutiveMalformed = 0;
      const result = step(handle, parsed.action);
      const observation = result.obs.messages.at(-1).content.slice(0, 4000);
      messages.push({ role: "user", content: observation });
      turns.at(-1).observation = observation;
      if (result.done) ended = "budget";
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }

  const score = handle.done ? partialCredit(handle) : finish(handle).reward;
  return {
    task_id: task.taskId,
    sample: sampleIndex,
    family: task.family,
    band: task.band,
    split: task.split,
    score: error ? null : score,
    steps: handle.step,
    ended,
    malformed,
    forbidden_effects: handle.forbiddenEffects.length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    error,
    ...(keepTranscripts ? { system: SYSTEM, prompt: task.prompt, turns } : {}),
  };
}

async function main() {
  const started = Date.now();
  const jobs = [];
  for (const task of pool) {
    for (let sample = 0; sample < samples; sample += 1) jobs.push({ task, sample });
  }
  const rows = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        rows.push(await runEpisode(job.task, job.sample));
        process.stderr.write(`\r${rows.length}/${jobs.length} done`);
      }
    }),
  );
  process.stderr.write("\n");

  const scored = rows.filter((row) => typeof row.score === "number");
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const byFamily = {};
  const byBand = {};
  for (const row of scored) {
    (byFamily[row.family] ??= []).push(row.score);
    (byBand[row.band] ??= []).push(row.score);
  }
  const report = {
    schema_version: "understudy.workload_slice_rollout.v1",
    model,
    slice_id: SLICE.slice_id,
    workload_code: SLICE.workload_code,
    fixture: SLICE.fixture_id,
    split,
    split_sha256: sliceSplitSha256(split),
    pool_size: sliceCounts()[split],
    samples_per_task: samples,
    temperature,
    episodes: rows.length,
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    bands: SLICE_BANDS,
    over_acting_episodes: rows.filter((row) => (row.forbidden_effects ?? 0) > 0).length,
    forbidden_writes: rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
    prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    rows: rows.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.sample - b.sample),
  };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

await main();
