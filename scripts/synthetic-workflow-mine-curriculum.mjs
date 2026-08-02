#!/usr/bin/env node
/**
 * Mine train-only synthetic workflow trajectories from a Tinker base
 * model. The environment is fully offline and synthetic; this script never
 * reads customer data and refuses every split other than train.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import {
  FROZEN_HOLDOUT_SHA256,
  TASKS,
  assertionSatisfied,
  finish,
  fixtureSha256,
  oraclePolicy,
  partialCredit,
  reset,
  splitSha256,
  step,
  taskPool,
} from "../dist/synthetic-workflow-offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const split = argValue("--split", "train");
if (split !== "train") throw new Error(`--split is hard-locked to train (received ${split})`);
const samples = Number(argValue("--samples", "8"));
const concurrency = Number(argValue("--concurrency", "4"));
const maxTurns = Number(argValue("--max-turns", "14"));
const maxTokens = Number(argValue("--max-tokens", "512"));
const temperature = Number(argValue("--temperature", "0.7"));
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const baseUrl = argValue("--base-url", "http://127.0.0.1:8099/v1");
const model = argValue("--model", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16");
const outputDir = argValue("--output-dir", "outputs/synthetic-workflow-curriculum");
const runId = argValue("--run-id", `synthetic-workflow-${Date.now()}-${randomUUID().slice(0, 8)}`);
const progressLog = argValue("--progress-log", `${outputDir}/progress.jsonl`);
const apiKey = process.env.TINKER_API_KEY || "shim-dummy-bearer";
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

const SYSTEM = [
  "You operate workflow apps through api_search and api_fetch.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/records"}}',
  '  {"tool": "finish", "arguments": {}}',
  "",
  "Read before you write and make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

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
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-request-id": `${runId}-${randomUUID()}`,
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(310_000),
    });
  } catch (error) {
    if (attempt < 6) {
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      return chat(messages, attempt + 1);
    }
    throw error;
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
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

function assistantMessage(action) {
  return JSON.stringify({ tool: action.name, arguments: action.arguments });
}

function appendToolResult(messages, result) {
  messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
}

function oracleTranscript(task) {
  const { handle } = reset(task.taskId);
  const messages = [...handle.messages];
  const policy = oraclePolicy(task.taskId);
  for (let index = 0; index < task.oracle.length; index += 1) {
    const action = task.oracle[index];
    const policyAction = policy({ step: index });
    if (JSON.stringify(policyAction) !== JSON.stringify(action)) {
      throw new Error(`oracle policy mismatch for ${task.taskId} at step ${index}`);
    }
    messages.push({ role: "assistant", content: assistantMessage(action) });
    appendToolResult(messages, step(handle, action));
  }
  finish(handle);
  messages.push({ role: "assistant", content: JSON.stringify({ tool: "finish", arguments: {} }) });
  if (partialCredit(handle) !== 1 || handle.forbiddenEffects.length > 0) {
    throw new Error(`oracle replay failed for ${task.taskId}: reward=${partialCredit(handle)}`);
  }
  return messages;
}

async function runEpisode(task, sampleIndex) {
  const startedAt = Date.now();
  const { handle } = reset(task.taskId);
  const messages = [...handle.messages];
  let malformed = 0;
  let consecutiveMalformed = 0;
  let ended = "budget";
  let error = null;
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    for (let turn = 0; turn < maxTurns && !handle.done; turn += 1) {
      const reply = await chat(messages);
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      messages.push({ role: "assistant", content: reply.text || "(empty)" });
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
        messages.push({ role: "user", content: `rejected: ${parsed.error}. Reply with exactly one JSON tool object.` });
        continue;
      }
      consecutiveMalformed = 0;
      const result = step(handle, parsed.action);
      appendToolResult(messages, result);
      if (result.done) ended = "budget";
    }
    if (!handle.done && ended === "budget") finish(handle);
  } catch (cause) {
    error = String(cause?.message ?? cause);
    ended = "error";
    finish(handle);
  }
  const reward = error ? 0 : partialCredit(handle);
  const initialState = reset(task.taskId).handle.state;
  const missingAssertionsCount = task.assertions.filter(
    (assertion) => !assertionSatisfied(initialState, assertion) && !assertionSatisfied(handle.state, assertion),
  ).length;
  return {
    task_id: task.taskId,
    family: task.family,
    band: task.band,
    split: "train",
    sample_index: sampleIndex,
    reward,
    steps: handle.step,
    ended,
    forbidden_effects: [...handle.forbiddenEffects],
    malformed,
    tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
    transcript: messages,
    error,
    missing_assertions_count: missingAssertionsCount,
    elapsed_ms: Date.now() - startedAt,
  };
}

function classify(episode) {
  if (episode.reward === 1 && episode.forbidden_effects.length === 0) return "pass";
  if (episode.reward > 0 && episode.reward < 1 && episode.forbidden_effects.length === 0) return "near_miss";
  if (
    episode.ended === "malformed" ||
    episode.forbidden_effects.length > 0 ||
    episode.ended === "budget" ||
    (episode.reward === 0 && episode.ended !== "error")
  ) return "tool_call_failure";
  return "other_fail";
}

function checkLeakage(tasks) {
  const train = new Set(TASKS.filter((task) => task.split === "train").map((task) => task.taskId));
  const dev = new Set(TASKS.filter((task) => task.split === "dev").map((task) => task.taskId));
  const holdout = new Set(TASKS.filter((task) => task.split === "holdout").map((task) => task.taskId));
  const overlap = (a, b) => [...a].filter((id) => b.has(id));
  const mined = tasks.map((task) => task.task_id);
  const violations = [
    ...mined.filter((id) => !train.has(id)).map((id) => `non-train task: ${id}`),
    ...overlap(train, dev).map((id) => `train/dev overlap: ${id}`),
    ...overlap(train, holdout).map((id) => `train/holdout overlap: ${id}`),
    ...overlap(dev, holdout).map((id) => `dev/holdout overlap: ${id}`),
  ];
  if (violations.length) throw new Error(`leakage check failed: ${violations.join(", ")}`);
  return { passed: true, mined_task_ids: [...new Set(mined)].sort(), violations: [] };
}

function provenance(episode, generatedAt) {
  return {
    model,
    lane: "tinker",
    renderer: "nemotron3",
    temperature,
    sample_index: episode.sample_index,
    run_id: runId,
    generated_at: generatedAt,
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function buildArtifacts(episodes, startedAt, endedAt) {
  const generatedAt = new Date().toISOString();
  const taskById = new Map(TASKS.map((task) => [task.taskId, task]));
  const oracleByTask = new Map();
  for (const task of TASKS.filter((candidate) => candidate.split === "train")) oracleByTask.set(task.taskId, oracleTranscript(task));
  const byTask = new Map();
  for (const episode of episodes) (byTask.get(episode.task_id) ?? byTask.set(episode.task_id, []).get(episode.task_id)).push(episode);
  const dpo = [];
  const sft = [];
  for (const [taskId, rows] of byTask) {
    const task = taskById.get(taskId);
    const passing = rows.filter((row) => classify(row) === "pass");
    const chosen = passing.sort((a, b) => b.reward - a.reward)[0];
    for (const rejected of rows.filter((row) => classify(row) === "near_miss")) {
      dpo.push({
        schema: "understudy.synthetic_workflow.dpo_pair.v1",
        task_id: taskId,
        family: task.family,
        band: task.band,
        split: "train",
        chosen_messages: chosen?.transcript ?? oracleByTask.get(taskId),
        rejected_messages: rejected.transcript,
        chosen_reward: chosen?.reward ?? 1,
        rejected_reward: rejected.reward,
        chosen_source: chosen ? "sampled" : "oracle",
        rejected_failure: {
          ended: rejected.ended,
          forbidden_effects: rejected.forbidden_effects,
          missing_assertions_count: rejected.missing_assertions_count,
        },
        provenance: provenance(chosen ?? { sample_index: 0 }, generatedAt),
      });
    }
    for (const row of rows.filter((episode) => classify(episode) === "tool_call_failure")) {
      const failureMode = row.ended === "malformed"
        ? "malformed"
        : row.forbidden_effects.length > 0
          ? "forbidden_write"
          : row.ended === "budget"
            ? "budget_exhausted"
            : "wrong_tool_sequence";
      sft.push({
        schema: "understudy.synthetic_workflow.sft_toolfail.v1",
        task_id: taskId,
        family: task.family,
        band: task.band,
        split: "train",
        failure_mode: failureMode,
        failed_transcript: row.transcript,
        messages: oracleByTask.get(taskId),
        provenance: provenance(row, generatedAt),
      });
    }
  }
  const leakage = checkLeakage(episodes);
  const counts = { episodes: episodes.length, classes: {}, dpo_pairs: dpo.length, sft_rows: sft.length };
  for (const episode of episodes) counts.classes[classify(episode)] = (counts.classes[classify(episode)] ?? 0) + 1;
  const familyBreakdown = {};
  for (const episode of episodes) {
    const family = familyBreakdown[episode.family] ??= { episodes: 0, pass: 0, near_miss: 0, tool_call_failure: 0, other_fail: 0 };
    family.episodes += 1;
    family[classify(episode)] += 1;
  }
  const tokens = episodes.reduce((sum, episode) => sum + episode.tokens.total, 0);
  const summary = {
    run_id: runId,
    model,
    lane: "tinker",
    renderer: "nemotron3",
    split: "train",
    samples_per_task: samples,
    task_count: new Set(episodes.map((episode) => episode.task_id)).size,
    temperature,
    max_turns: maxTurns,
    max_tokens: maxTokens,
    counts,
    family_breakdown: familyBreakdown,
    mean_reward: episodes.length ? episodes.reduce((sum, episode) => sum + episode.reward, 0) / episodes.length : 0,
    pass_rate: episodes.length ? (counts.classes.pass ?? 0) / episodes.length : 0,
    token_totals: { total: tokens, prompt: episodes.reduce((sum, episode) => sum + episode.tokens.prompt, 0), completion: episodes.reduce((sum, episode) => sum + episode.tokens.completion, 0) },
    wall_clock_s: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000),
  };
  const manifest = {
    schema: "understudy.synthetic_workflow.curriculum_manifest.v1",
    run_id: runId,
    counts: { ...counts, by_family: familyBreakdown },
    fixture_sha256: fixtureSha256(),
    split_sha256: { train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") },
    sealed_holdout_sha256: FROZEN_HOLDOUT_SHA256,
    leakage_check: leakage,
    run_params: { samples, temperature, max_turns: maxTurns, max_tokens: maxTokens, model, lane: "tinker", renderer: "nemotron3" },
    wall_clock: { started_at: startedAt, ended_at: endedAt, seconds: summary.wall_clock_s },
    token_totals: summary.token_totals,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/dpo_pairs.jsonl`, dpo.map((row) => JSON.stringify(row)).join("\n") + (dpo.length ? "\n" : ""));
  writeFileSync(`${outputDir}/sft_toolfail.jsonl`, sft.map((row) => JSON.stringify(row)).join("\n") + (sft.length ? "\n" : ""));
  writeFileSync(`${outputDir}/rollouts-summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const artifactSha256 = {
    rollouts: sha256File(`${outputDir}/rollouts.jsonl`),
    dpo_pairs: sha256File(`${outputDir}/dpo_pairs.jsonl`),
    sft_toolfail: sha256File(`${outputDir}/sft_toolfail.jsonl`),
    rollouts_summary: sha256File(`${outputDir}/rollouts-summary.json`),
  };
  manifest.artifacts = {
    "rollouts.jsonl": artifactSha256.rollouts,
    "dpo_pairs.jsonl": artifactSha256.dpo_pairs,
    "sft_toolfail.jsonl": artifactSha256.sft_toolfail,
    "rollouts-summary.json": artifactSha256.rollouts_summary,
  };
  writeFileSync(`${outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dpo, sft, summary, manifest };
}

async function main() {
  const startedAt = new Date().toISOString();
  const tasks = taskPool({ split: "train" });
  mkdirSync(outputDir, { recursive: true });
  let cursor = 0;
  const episodes = [];
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
        episodes.push(await runEpisode(task, sampleIndex));
        const completed = episodes.at(-1);
        appendFileSync(progressLog, `${JSON.stringify({
          run_id: runId,
          completed: episodes.length,
          total: tasks.length * samples,
          task_id: completed.task_id,
          sample_index: completed.sample_index,
          ended: completed.ended,
          reward: completed.reward,
          elapsed_ms: completed.elapsed_ms,
          tokens: completed.tokens,
        })}\n`);
        process.stderr.write(`\r${episodes.length}/${tasks.length * samples} episodes`);
      }
    }
  });
  await Promise.all(workers);
  process.stderr.write("\n");
  episodes.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.sample_index - b.sample_index);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(`${outputDir}/rollouts.jsonl`, episodes.map((row) => JSON.stringify({ ...row, classification: classify(row) })).join("\n") + "\n");
  const endedAt = new Date().toISOString();
  const artifacts = buildArtifacts(episodes, startedAt, endedAt);
  console.log(JSON.stringify(artifacts.summary, null, 2));
}

await main();
