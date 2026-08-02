#!/usr/bin/env node
/**
 * Zero-shot difficulty probe for the AutomationBench v2 offline fixture.
 *
 * Drives a base model through the in-process offline environment over an
 * OpenAI-compatible chat endpoint (Fireworks serverless by default — no
 * dedicated deployment, no GPU quota). Tool calls are driven through the
 * sampling path: the model emits ONE JSON object per turn and a malformed
 * emission is rejected rather than repaired, so the score reflects the model's
 * own tool-call discipline.
 *
 * This script only measures. It never trains, never selects on holdout, and
 * refuses the holdout split unless the frozen hash is supplied.
 *
 * Usage:
 *   FIREWORKS_API_KEY=... node scripts/automationbench-v2-zeroshot.mjs \
 *     --model accounts/fireworks/models/gpt-oss-20b --split dev --limit 20 --out outputs/x.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { finish, partialCredit, reset, step } from "../dist/automationbench-offline.js";
import { V2_TASKS, v2FixtureSha256, v2SplitSha256, v2TaskBands, v2TaskPool } from "../dist/automationbench-v2.js";
import { OEE_TASKS, oeeFixtureSha256, oeeSplitSha256, oeeTaskBands, oeeTaskPool, WORKLOAD_OEE } from "../dist/workload-on-event-execution.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
if (!model) throw new Error("--model is required");
const fixture = argValue("--fixture", "v2");
const fixtureConfig =
  fixture === "v2"
    ? {
        fixtureId: "automationbench-simple-api-offline-hard-v2",
        tasks: V2_TASKS,
        bands: v2TaskBands(),
        fixtureSha: v2FixtureSha256,
        splitHash: v2SplitSha256,
        pool: v2TaskPool,
      }
    : fixture === "on-event-execution"
      ? {
          fixtureId: WORKLOAD_OEE.fixture_id,
          tasks: OEE_TASKS,
          bands: oeeTaskBands(),
          fixtureSha: oeeFixtureSha256,
          splitHash: oeeSplitSha256,
          pool: oeeTaskPool,
        }
      : null;
if (!fixtureConfig) throw new Error(`unknown --fixture ${fixture}; expected v2 or on-event-execution`);
const split = argValue("--split", "dev");
const limit = Number(argValue("--limit", "0")) || 0;
const stride = Number(argValue("--stride", "1")) || 1;
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "14"));
const temperature = Number(argValue("--temperature", "0"));
const rolloutsArg = argValue("--rollouts", null);
const samplesArg = argValue("--samples", null);
const rollouts = Number(rolloutsArg ?? samplesArg ?? "1");
if (!Number.isInteger(rollouts) || rollouts < 1) throw new Error("--rollouts/--samples must be a positive integer");
// A malformed emission is always rejected (never executed); this only bounds how
// many consecutive rejections an episode survives before it is abandoned.
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const keepTranscripts = process.argv.includes("--transcripts");
const samplesMode = samplesArg !== null || keepTranscripts;
const preserveV2Default = fixture === "v2" && rolloutsArg === null && samplesArg === null && !keepTranscripts;
const maxTokens = Number(argValue("--max-tokens", "512"));
const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");
// The Tinker lane is scored through the local shim (`scripts/tinker-openai-shim.py`),
// which authenticates to Tinker itself and ignores the bearer token.
const isLocalShim = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(baseUrl);
const apiKey = process.env.FIREWORKS_API_KEY ?? (isLocalShim ? "local-shim" : undefined);
if (!apiKey) throw new Error("FIREWORKS_API_KEY is required (never hard-code it)");

const pool = fixtureConfig.pool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
// Reporting-only difficulty band per family; scoring never reads it.
const BANDS = fixtureConfig.bands;
const strided = pool.filter((_task, index) => index % stride === 0);
const tasks = limit > 0 ? strided.slice(0, limit) : strided;

const SYSTEM = [
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

/** Strict parse: one JSON object naming a known tool. No repair, no salvage of prose. */
function parseAction(text) {
  // Reasoning bases emit a think block before the call; it is scratch, not a tool call.
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
    // Serverless rate limits are a throughput artefact, not a benchmark signal.
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

async function runTask(task, rolloutIndex = 0) {
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
  /** Per-turn record: the prefix the model saw, what it emitted, whether it was rejected. */
  const transcript = [];

  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      const prefix = keepTranscripts ? messages.map((message) => ({ ...message })) : null;
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
      const parsed = parseAction(reply.text);
      if (keepTranscripts) transcript.push({ turn, prefix, emission: reply.text ?? "", rejected: Boolean(parsed.error) });
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
        messages.push({ role: "user", content: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.` });
        continue;
      }
      consecutiveMalformed = 0;
      const result = step(handle, parsed.action);
      messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
      if (result.done) ended = "budget";
    }
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
  }

  const score = handle.done ? partialCredit(handle) : finish(handle).reward;
  const family =
    fixture === "on-event-execution"
      ? task.taskId.replace(/^oee-/, "").replace(/-\d{2}$/, "")
      : task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
  const row = {
    task_id: task.taskId,
    ...(preserveV2Default || samplesMode ? { sample: rolloutIndex } : {}),
    ...(rollouts > 1 ? { rollout_index: rolloutIndex } : {}),
    family,
    band: BANDS[family] ?? "unknown",
    tier: fixture === "on-event-execution" ? "oee" : task.taskId.startsWith("hard-") ? "hard" : "v1",
    split: task.split,
    score: error ? null : score,
    steps: handle.step,
    ended,
    malformed,
    forbidden_effects: handle.forbiddenEffects.length,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    error,
    ...(keepTranscripts ? { transcript } : {}),
  };
  return { row, transcript: { task_id: task.taskId, rollout_index: rolloutIndex, split: task.split, messages } };
}

async function main() {
  const started = Date.now();
  const rows = [];
  const transcripts = [];
  let cursor = 0;
  const episodes = tasks.flatMap((task) => Array.from({ length: rollouts }, (_unused, rolloutIndex) => ({ task, rolloutIndex })));
  const workers = Array.from({ length: Math.min(concurrency, episodes.length) }, async () => {
    while (cursor < episodes.length) {
      const { task, rolloutIndex } = episodes[cursor++];
      const result = await runTask(task, rolloutIndex);
      rows.push(result.row);
      if (rollouts > 1) transcripts.push(result.transcript);
      process.stderr.write(`\r${rows.length}/${episodes.length} done`);
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");

  const scored = rows.filter((row) => typeof row.score === "number");
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  const byTier = {};
  const byFamily = {};
  const byBand = {};
  for (const row of scored) {
    (byTier[row.tier] ??= []).push(row.score);
    (byFamily[row.family] ??= []).push(row.score);
    (byBand[row.band] ??= []).push(row.score);
  }
  const report = {
    model,
    split,
    ...(preserveV2Default
      ? {
          fixture: fixtureConfig.fixtureId,
          split_sha256: fixtureConfig.splitHash(split),
          pool_size: fixtureConfig.tasks.filter((task) => task.split === split).length,
          sampled: tasks.length,
          samples_per_task: rollouts,
          temperature,
          max_tokens: maxTokens,
        }
      : {
          fixture,
          fixture_id: fixtureConfig.fixtureId,
          fixture_sha256: fixtureConfig.fixtureSha(),
          split_sha256: fixtureConfig.splitHash(split),
          pool_size: fixtureConfig.tasks.filter((task) => task.split === split).length,
          sampled: tasks.length * rollouts,
          ...(samplesMode || rollouts > 1 ? { samples_per_task: rollouts, temperature, max_tokens: maxTokens } : {}),
        }),
    scored: scored.length,
    errors: rows.length - scored.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    mean_by_tier: Object.fromEntries(Object.entries(byTier).map(([key, values]) => [key, mean(values)])),
    mean_by_family: Object.fromEntries(Object.entries(byFamily).map(([key, values]) => [key, mean(values)])),
    mean_by_band: Object.fromEntries(Object.entries(byBand).map(([key, values]) => [key, mean(values)])),
    // Over-action guard: a policy that writes outside `allowedWrites` scores 0 for
    // that episode, so the raw counts matter even when the rate rounds to zero.
    over_acting_episodes: rows.filter((row) => (row.forbidden_effects ?? 0) > 0).length,
    forbidden_writes: rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    forbidden_effect_rate: scored.length === 0 ? null : scored.filter((row) => row.forbidden_effects > 0).length / scored.length,
    malformed_rate: rows.length === 0 ? null : rows.filter((row) => row.malformed > 0).length / rows.length,
    prompt_tokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
    completion_tokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
    wall_clock_s: Math.round((Date.now() - started) / 1000),
    rows: rows.sort((a, b) => a.task_id.localeCompare(b.task_id) || (a.rollout_index ?? a.sample ?? 0) - (b.rollout_index ?? b.sample ?? 0)),
  };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    if (rollouts > 1) {
      const transcriptPath = outPath.replace(/\.json$/i, ".transcripts.jsonl");
      writeFileSync(
        transcriptPath,
        `${transcripts
          .sort((a, b) => a.task_id.localeCompare(b.task_id) || a.rollout_index - b.rollout_index)
          .map((transcript) => JSON.stringify(transcript))
          .join("\n")}\n`,
      );
    }
  }
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

await main();
