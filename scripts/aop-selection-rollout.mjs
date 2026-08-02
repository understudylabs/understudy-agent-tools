#!/usr/bin/env node
/**
 * Score a model on the aop-selection synthetic slice, outcome-first.
 *
 * Drives a model through the in-process offline environment over an
 * OpenAI-compatible chat endpoint (the Tinker shim for the Nemotron lane). Tool
 * calls go through plain sampling — one JSON object per turn — and a malformed
 * emission is rejected rather than repaired, so the score reflects the model's
 * own tool-call discipline.
 *
 * With `--samples N --temperature T` it draws N independent episodes per task
 * and, with `--transcripts`, writes every episode's message list. That is the
 * input the pair miner needs: a passing and a near-miss episode over the same
 * prefix. This script only measures — it never trains and refuses the holdout
 * split unless the frozen hash is supplied.
 *
 * Usage:
 *   node scripts/aop-selection-rollout.mjs --model nemotron-3-nano \
 *     --base-url http://localhost:8099/v1 --split dev --out outputs/aop/base-dev.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  AOP_TASKS,
  aopFinish,
  aopPartialCredit,
  aopReset,
  aopSplitSha256,
  aopStep,
  aopTaskPool,
} from "../dist/aop-selection-offline.js";

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
const samples = Number(argValue("--samples", "1"));
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "10"));
const temperature = Number(argValue("--temperature", "0"));
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const maxTokens = Number(argValue("--max-tokens", "384"));
const baseUrl = argValue("--base-url", "http://localhost:8099/v1");
const outPath = argValue("--out");
const transcriptPath = argValue("--transcripts");
const frozenHoldout = argValue("--frozen-holdout");
const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

const pool = aopTaskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const tasks = limit > 0 ? pool.slice(0, limit) : pool;

const SYSTEM = [
  "You resolve action options from workflow events through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/conversations/conv_x"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the selected option has been applied',
  "",
  "Read the event before you write. Apply the option to the one account the event addresses.",
  "Writing to an account the event did not address scores zero for the whole task.",
].join("\n");

/** Strict parse: one JSON object naming a known tool. No repair, no salvage of prose. */
function parseAction(text) {
  const visible = String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*<\/think>/, "");
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
  const { handle } = aopReset(task.taskId);
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

  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      const parsed = parseAction(reply.text);
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
        messages.push({
          role: "user",
          content: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.`,
        });
        continue;
      }
      consecutiveMalformed = 0;
      const result = aopStep(handle, parsed.action);
      messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
      if (result.done) ended = "budget";
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }

  const score = handle.done ? aopPartialCredit(handle) : aopFinish(handle).reward;
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
    messages,
  };
}

async function main() {
  const started = Date.now();
  const units = [];
  for (const task of tasks) {
    for (let sample = 0; sample < samples; sample += 1) units.push({ task, sample });
  }
  const episodes = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, units.length) }, async () => {
    while (cursor < units.length) {
      const unit = units[cursor++];
      episodes.push(await runEpisode(unit.task, unit.sample));
      process.stderr.write(`\r${episodes.length}/${units.length} episodes`);
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");

  // One row per task: with --samples > 1 the reported score is the sample mean,
  // so a lucky single rollout cannot stand in for the policy.
  const byTask = new Map();
  for (const episode of episodes) {
    const bucket = byTask.get(episode.task_id) ?? [];
    bucket.push(episode);
    byTask.set(episode.task_id, bucket);
  }
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const rows = [...byTask.entries()].map(([taskId, bucket]) => {
    const scored = bucket.filter((episode) => typeof episode.score === "number");
    return {
      task_id: taskId,
      family: bucket[0].family,
      band: bucket[0].band,
      split: bucket[0].split,
      samples: bucket.length,
      score: scored.length === 0 ? null : mean(scored.map((episode) => episode.score)),
      pass_rate: scored.length === 0 ? null : scored.filter((episode) => episode.score === 1).length / scored.length,
      steps: Math.round(mean(bucket.map((episode) => episode.steps))),
      ended: bucket[0].ended,
      malformed: bucket.reduce((sum, episode) => sum + episode.malformed, 0),
      forbidden_effects: bucket.reduce((sum, episode) => sum + episode.forbidden_effects, 0),
      prompt_tokens: bucket.reduce((sum, episode) => sum + episode.prompt_tokens, 0),
      completion_tokens: bucket.reduce((sum, episode) => sum + episode.completion_tokens, 0),
      error: bucket.find((episode) => episode.error)?.error ?? null,
    };
  }).sort((a, b) => a.task_id.localeCompare(b.task_id));

  const scored = rows.filter((row) => typeof row.score === "number");
  const byBand = {};
  const byFamily = {};
  for (const row of scored) {
    (byBand[row.band] ??= []).push(row.score);
    (byFamily[row.family] ??= []).push(row.score);
  }
  const report = {
    model,
    split,
    fixture: "aop-selection-offline-v1",
    split_sha256: aopSplitSha256(split),
    pool_size: AOP_TASKS.filter((task) => task.split === split).length,
    sampled: tasks.length,
    samples_per_task: samples,
    temperature,
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: scored.length === 0 ? null : mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    over_acting_episodes: episodes.filter((episode) => episode.forbidden_effects > 0).length,
    forbidden_writes: episodes.reduce((sum, episode) => sum + episode.forbidden_effects, 0),
    malformed_rate: episodes.length === 0 ? null : episodes.filter((episode) => episode.malformed > 0).length / episodes.length,
    prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    rows,
  };

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (transcriptPath) {
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      `${episodes.map((episode) => JSON.stringify(episode)).join("\n")}\n`,
    );
  }
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

await main();
