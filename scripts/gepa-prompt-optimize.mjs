#!/usr/bin/env node
/**
 * Train-only GEPA-style prompt optimization for the synthetic AutomationBench
 * v2 fixture. This script never reads the dev or holdout pools.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { v2TaskBands, v2TaskPool } from "../dist/automationbench-v2.js";
import { makeChat, runEpisode } from "./lib/automationbench-episode.mjs";

const DEFAULT_REFLECTION_MODEL = "claude-sonnet-4-6";
const FIXTURE_ID = "automationbench-simple-api-offline-v2";

function argValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function familyForTask(task) {
  return task.taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

export function selectTrainSubset(tasks, bands, size) {
  const grouped = new Map();
  for (const task of tasks.filter((candidate) => candidate.split === "train")) {
    const family = familyForTask(task);
    const band = bands[family] ?? "unknown";
    if (!grouped.has(band)) grouped.set(band, []);
    grouped.get(band).push(task);
  }
  for (const values of grouped.values()) values.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const selected = [];
  const bandNames = [...grouped.keys()].sort();
  while (selected.length < size && bandNames.some((band) => grouped.get(band).length > 0)) {
    for (const band of bandNames) {
      const task = grouped.get(band).shift();
      if (task) selected.push(task);
      if (selected.length >= size) break;
    }
  }
  return selected;
}

export function rotatingBatch(tasks, cursor, size) {
  if (tasks.length === 0 || size <= 0) return { tasks: [], nextCursor: cursor };
  const batch = Array.from({ length: Math.min(size, tasks.length) }, (_unused, index) => tasks[(cursor + index) % tasks.length]);
  return { tasks: batch, nextCursor: (cursor + batch.length) % tasks.length };
}

export function buildReflectionBrief({ currentPrompt, examples }) {
  const sections = [
    "Current system prompt:",
    "```text",
    currentPrompt,
    "```",
    "",
    "Rollout evidence from the current minibatch follows. Task labels are positional and contain no task identifiers.",
  ];
  examples.forEach((example, index) => {
    sections.push(
      "",
      `Example ${index + 1}`,
      "User prompt:",
      "```text",
      example.userPrompt,
      "```",
      `Feedback: ${example.feedback ?? "No rollout feedback was recorded."}`,
      "Transcript (actions, observations, and rejection messages):",
      "```text",
      example.transcript.length > 0
        ? example.transcript.map((entry) => `${entry.role}: ${entry.content}`).join("\n")
        : "[transcript omitted; feedback retained]",
      "```",
      `Forbidden-effect count: ${example.forbiddenEffects}`,
      `Malformed/rejection count: ${example.malformed}`,
      `Scalar final-state score: ${example.score}`,
    );
  });
  return sections.join("\n");
}

export function trimReflectionExamples(examples, limit = 4) {
  const ranked = [...examples].sort((left, right) => {
    const leftScore = typeof left.score === "number" ? left.score : -1;
    const rightScore = typeof right.score === "number" ? right.score : -1;
    return leftScore - rightScore || left.taskId.localeCompare(right.taskId);
  });
  const transcriptTasks = new Set(ranked.slice(0, Math.max(0, limit)).map((example) => example.taskId));
  return examples.map((example) => ({
    ...example,
    transcript: transcriptTasks.has(example.taskId) ? example.transcript : [],
    transcript_omitted: !transcriptTasks.has(example.taskId),
  }));
}

export function fixtureLiteralReason(prompt, { taskIds = [], transcript = [] } = {}) {
  const text = String(prompt ?? "");
  const emailToken = text.match(/\S*@\S+/);
  if (emailToken) return `contains @ token: ${emailToken[0]}`;
  const observed = transcript.map((entry) => String(entry.content ?? "")).join("\n");
  const recordIds = [...new Set(observed.match(/\b[a-z]+-\d+\b/g) ?? [])];
  const recordId = recordIds.find((id) => text.includes(id));
  if (recordId) return `contains observed record id: ${recordId}`;
  const taskId = taskIds.find((id) => id && text.includes(id));
  if (taskId) return `contains task id: ${taskId}`;
  return null;
}

export function extractTextFence(text) {
  const match = String(text ?? "").match(/^\s*```text\s*\n?([\s\S]*?)\n?```\s*$/i);
  return match ? match[1].trim() : null;
}

export function selectParent(candidates, tasks, cursor = 0) {
  const leaders = new Map();
  for (const task of tasks) {
    const scored = candidates
      .map((candidate) => ({ candidate, score: candidate.scores[task.taskId] }))
      .filter((entry) => typeof entry.score === "number");
    if (scored.length === 0) continue;
    const best = Math.max(...scored.map((entry) => entry.score));
    for (const entry of scored) {
      if (entry.score === best) leaders.set(entry.candidate.id, (leaders.get(entry.candidate.id) ?? 0) + 1);
    }
  }
  const frontier = candidates.filter((candidate) => leaders.has(candidate.id));
  if (frontier.length === 0) return candidates[0];
  const total = frontier.reduce((sum, candidate) => sum + leaders.get(candidate.id), 0);
  let offset = cursor % total;
  for (const candidate of frontier) {
    const weight = leaders.get(candidate.id);
    if (offset < weight) return candidate;
    offset -= weight;
  }
  return frontier.at(-1);
}

async function reflectionCall({ apiKey, model, brief, attempt = 0 }) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for reflection");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: "You improve a general system prompt for a synthetic tool-calling agent. Return the full replacement system prompt inside exactly one ```text fence and nothing else. Keep it general: do not include task ids, record ids, email addresses, or proper nouns from observations.",
      messages: [{
        role: "user",
        content: `Improve the prompt using only this rollout evidence. Preserve useful behavior and fix the observed failure modes.\n\n${brief}`,
      }],
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      return reflectionCall({ apiKey, model, brief, attempt: attempt + 1 });
    }
    throw new Error(`reflection failed ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  return payload.content?.map((block) => block.type === "text" ? block.text : "").join("") ?? "";
}

function writeState(outDir, state) {
  writeFileSync(join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function scalarEpisode(row) {
  return {
    task_id: row.task_id,
    score: row.score,
    feedback: row.feedback,
    malformed: row.malformed,
    forbidden_effects: row.forbidden_effects,
    steps: row.steps,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    ended: row.ended,
    error: row.error,
  };
}

function readEpisodeRows(path) {
  const rows = new Map();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    rows.set(`${row.candidate_id}:${row.task_id}`, row);
  }
  return rows;
}

function appendEpisodeRows(path, candidateId, rows) {
  if (rows.length === 0) return;
  appendFileSync(path, `${rows.map((row) => JSON.stringify({ candidate_id: candidateId, ...row })).join("\n")}\n`);
}

function candidateMean(candidate, taskIds) {
  return mean(taskIds.map((taskId) => candidate.scores[taskId]).filter((score) => typeof score === "number"));
}

async function optimize(options) {
  mkdirSync(options.outDir, { recursive: true });
  const statePath = join(options.outDir, "state.json");
  const iterationsPath = join(options.outDir, "iterations.jsonl");
  const episodesPath = join(options.outDir, "episodes.jsonl");
  const bands = v2TaskBands();
  const trainPool = v2TaskPool({ split: "train" });
  const trainSubset = selectTrainSubset(trainPool, bands, options.trainSize);
  const taskIds = trainSubset.map((task) => task.taskId);
  const config = {
    fixture: FIXTURE_ID,
    model: options.model,
    base_url: options.baseUrl,
    api_key_env: options.apiKeyEnv,
    seed_prompt_file: options.seedPromptFile,
    train_size: options.trainSize,
    minibatch: options.minibatch,
    iterations: options.iterations,
    max_rollouts: options.maxRollouts,
    concurrency: options.concurrency,
    max_turns: options.maxTurns,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    reflection_transcripts: options.reflectionTranscripts,
    seed_prompt_sha256: createHash("sha256").update(readFileSync(options.seedPromptFile)).digest("hex"),
    reflection_model: options.reflectionModel,
    train_task_ids: taskIds,
  };
  let state;
  if (options.resume) {
    if (!existsSync(statePath)) throw new Error(`--resume requested but ${statePath} does not exist`);
    state = JSON.parse(readFileSync(statePath, "utf8"));
    if (JSON.stringify(state.config) !== JSON.stringify(config)) throw new Error("resume config does not match state.json");
  } else {
    const seedPrompt = readFileSync(options.seedPromptFile, "utf8");
    state = {
      config,
      candidates: [{
        id: "c0",
        prompt: seedPrompt,
        prompt_sha256: createHash("sha256").update(seedPrompt).digest("hex"),
        scores: {},
        accepted: true,
        parent_id: null,
      }],
      cache: {},
      next_candidate: 1,
      iteration: 0,
      minibatch_cursor: 0,
      total_episodes: 0,
      reflection_calls: 0,
      consecutive_rejections: 0,
    };
    writeState(options.outDir, state);
  }

  const episodeRows = readEpisodeRows(episodesPath);
  for (const row of episodeRows.values()) {
    const candidate = state.candidates.find((entry) => entry.id === row.candidate_id);
    if (!candidate) continue;
    const key = `${row.candidate_id}:${row.task_id}`;
    state.cache[key] ??= scalarEpisode(row);
    candidate.scores[row.task_id] ??= row.score;
  }
  state.total_episodes = Math.max(state.total_episodes, episodeRows.size);

  const studentChat = makeChat({
    baseUrl: options.baseUrl,
    apiKey: process.env[options.apiKeyEnv] ?? "",
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  const taskById = new Map(trainSubset.map((task) => [task.taskId, task]));
  const candidateById = () => new Map(state.candidates.map((candidate) => [candidate.id, candidate]));

  async function evaluate(candidate, tasks) {
    const missing = tasks.filter((task) => !state.cache[`${candidate.id}:${task.taskId}`]);
    if (missing.length === 0) return;
    const remainingBudget = Math.max(0, options.maxRollouts - state.total_episodes);
    const runnable = missing.slice(0, remainingBudget);
    const budgetExhausted = runnable.length < missing.length;
    if (runnable.length === 0) return { budgetExhausted, rows: [] };
    let cursor = 0;
    const rows = [];
    const workers = Array.from({ length: Math.min(options.concurrency, runnable.length) }, async () => {
      while (cursor < runnable.length) {
        const task = runnable[cursor++];
        const row = await runEpisode({
          task,
          systemPrompt: candidate.prompt,
          chat: studentChat,
          maxTurns: options.maxTurns,
          malformedTolerance: 3,
          band: bands[familyForTask(task)],
        });
        state.cache[`${candidate.id}:${task.taskId}`] = scalarEpisode(row);
        episodeRows.set(`${candidate.id}:${task.taskId}`, { candidate_id: candidate.id, ...row });
        candidate.scores[task.taskId] = row.score;
        rows.push(row);
      }
    });
    await Promise.all(workers);
    appendEpisodeRows(episodesPath, candidate.id, rows);
    state.total_episodes += rows.length;
    writeState(options.outDir, state);
    return { budgetExhausted, rows };
  }

  const initial = candidateById().get("c0");
  let budgetExhausted = false;
  if (Object.keys(initial.scores).length < taskIds.length) {
    budgetExhausted = (await evaluate(initial, trainSubset))?.budgetExhausted ?? false;
  }
  while (!budgetExhausted && state.iteration < options.iterations && state.total_episodes < options.maxRollouts) {
    const iteration = state.iteration;
    const candidates = state.candidates;
    const parent = selectParent(candidates, trainSubset, iteration);
    const batchInfo = rotatingBatch(trainSubset, state.minibatch_cursor, options.minibatch);
    state.minibatch_cursor = batchInfo.nextCursor;
    const minibatch = batchInfo.tasks;
    const parentRows = minibatch.map((task) => state.cache[`${parent.id}:${task.taskId}`]).filter(Boolean);
    const parentMean = mean(parentRows.map((row) => row.score).filter((score) => typeof score === "number"));
    const examples = minibatch.map((task) => {
      const row = episodeRows.get(`${parent.id}:${task.taskId}`) ?? state.cache[`${parent.id}:${task.taskId}`];
      return {
        taskId: task.taskId,
        userPrompt: task.prompt,
        feedback: row?.feedback ?? "No rollout feedback was recorded.",
        transcript: row?.transcript ?? [],
        malformed: row?.malformed ?? 0,
        forbiddenEffects: row?.forbidden_effects ?? 0,
        score: row?.score ?? null,
      };
    });
    const brief = buildReflectionBrief({
      currentPrompt: parent.prompt,
      examples: trimReflectionExamples(examples, options.reflectionTranscripts),
    });
    const reflectionText = await reflectionCall({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: options.reflectionModel,
      brief,
    });
    state.reflection_calls += 1;
    writeState(options.outDir, state);
    const proposed = extractTextFence(reflectionText);
    const rejection = proposed ? fixtureLiteralReason(proposed, {
      taskIds: [...taskById.keys()],
      transcript: examples.flatMap((example) => example.transcript),
    }) : "reflection did not return a single ```text fence";
    let child = null;
    let accepted = false;
    let childMean = null;
    if (!rejection && proposed) {
      child = {
        id: `c${state.next_candidate++}`,
        prompt: proposed,
        prompt_sha256: createHash("sha256").update(proposed).digest("hex"),
        scores: {},
        accepted: false,
        parent_id: parent.id,
      };
      const childBatch = await evaluate(child, minibatch);
      childMean = candidateMean(child, minibatch.map((task) => task.taskId));
      accepted = childMean !== null && parentMean !== null && childMean > parentMean;
      if (accepted) {
        const remaining = trainSubset.filter((task) => !child.scores[task.taskId]);
        const childRemaining = await evaluate(child, remaining);
        if (childRemaining?.budgetExhausted) {
          budgetExhausted = true;
        } else {
          child.accepted = true;
          state.candidates.push(child);
        }
      }
      if (childBatch?.budgetExhausted) {
        budgetExhausted = true;
      }
    }
    if (accepted) state.consecutive_rejections = 0;
    else state.consecutive_rejections += 1;
    const record = {
      iteration,
      parent_id: parent.id,
      minibatch_task_ids: minibatch.map((task) => task.taskId),
      parent_mean: parentMean,
      child_mean: childMean,
      accepted,
      rejection,
      budget_exhausted: budgetExhausted,
      budget_reason: budgetExhausted ? "max-rollouts exhausted; preserved completed batches and stopped cleanly" : null,
      consecutive_rejections: state.consecutive_rejections,
      proposed_prompt: proposed,
      total_episodes: state.total_episodes,
      reflection_model: options.reflectionModel,
    };
    appendFileSync(iterationsPath, `${JSON.stringify(record)}\n`);
    state.iteration += 1;
    writeState(options.outDir, state);
    if (budgetExhausted || state.total_episodes >= options.maxRollouts) break;
  }

  const best = [...state.candidates]
    .sort((a, b) => (candidateMean(b, taskIds) ?? -1) - (candidateMean(a, taskIds) ?? -1))[0];
  const candidatesOutput = state.candidates.map((candidate) => ({
    ...candidate,
    train_subset_mean: candidateMean(candidate, taskIds),
  }));
  writeFileSync(join(options.outDir, "candidates.json"), `${JSON.stringify({
    fixture: FIXTURE_ID,
    split: "train",
    train_task_ids: taskIds,
    candidates: candidatesOutput,
    best_id: best?.id ?? null,
    total_episodes: state.total_episodes,
    consecutive_rejections: state.consecutive_rejections,
  }, null, 2)}\n`);
  if (best) writeFileSync(join(options.outDir, "best-prompt.txt"), best.prompt);
  return { best, state, trainSubset };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {
    model: argValue(argv, "--model"),
    baseUrl: argValue(argv, "--base-url", "http://127.0.0.1:8099/v1"),
    apiKeyEnv: argValue(argv, "--api-key-env", "FIREWORKS_API_KEY"),
    seedPromptFile: argValue(argv, "--seed-prompt-file"),
    trainSize: Number(argValue(argv, "--train-size", "24")),
    minibatch: Number(argValue(argv, "--minibatch", "6")),
    iterations: Number(argValue(argv, "--iterations", "4")),
    maxRollouts: Number(argValue(argv, "--max-rollouts", "500")),
    concurrency: Number(argValue(argv, "--concurrency", "6")),
    maxTurns: Number(argValue(argv, "--max-turns", "14")),
    maxTokens: Number(argValue(argv, "--max-tokens", "512")),
    temperature: Number(argValue(argv, "--temperature", "0")),
    reflectionTranscripts: Number(argValue(argv, "--reflection-transcripts", "4")),
    reflectionModel: argValue(argv, "--reflection-model", DEFAULT_REFLECTION_MODEL),
    outDir: argValue(argv, "--out-dir"),
    resume: hasFlag(argv, "--resume"),
  };
  for (const [name, value] of [["--model", options.model], ["--seed-prompt-file", options.seedPromptFile], ["--out-dir", options.outDir]]) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (!Number.isInteger(options.trainSize) || options.trainSize < 1) throw new Error("--train-size must be positive");
  if (!Number.isInteger(options.minibatch) || options.minibatch < 1) throw new Error("--minibatch must be positive");
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be positive");
  if (!Number.isInteger(options.maxRollouts) || options.maxRollouts < 1) throw new Error("--max-rollouts must be positive");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be positive");
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) throw new Error("--max-turns must be positive");
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) throw new Error("--max-tokens must be positive");
  if (!Number.isFinite(options.temperature) || options.temperature < 0) throw new Error("--temperature must be non-negative");
  if (!Number.isInteger(options.reflectionTranscripts) || options.reflectionTranscripts < 0) {
    throw new Error("--reflection-transcripts must be non-negative");
  }
  const result = await optimize(options);
  console.log(JSON.stringify({
    fixture: FIXTURE_ID,
    train_size: result.trainSubset.length,
    iterations: result.state.iteration,
    total_episodes: result.state.total_episodes,
    consecutive_rejections: result.state.consecutive_rejections,
    best_id: result.best?.id ?? null,
    best_train_subset_mean: result.best ? candidateMean(result.best, result.trainSubset.map((task) => task.taskId)) : null,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
