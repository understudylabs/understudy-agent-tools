#!/usr/bin/env node
/**
 * Mine near-hit DPO pairs from the base train rollouts for on-event-execution.
 *
 * The miner only reads the frozen train artifacts, replays the transcripts to
 * compare final states, and emits synthetic-only preference pairs plus a hash
 * manifest. Holdout is never touched; this script fails closed if any input row
 * is not train split.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "../dist/benchmark.js";
import { finish, reset, step } from "../dist/automationbench-offline.js";
import { oeeSplitSha256, WORKLOAD_OEE } from "../dist/workload-on-event-execution.js";

const DEFAULT_ROLLUPS_JSON = "outputs/oee/base-train-rollouts.json";
const DEFAULT_TRANSCRIPTS_JSONL = "outputs/oee/base-train-rollouts.transcripts.jsonl";
const DEFAULT_OUT_DIR = "outputs/oee/dpo";
const MAX_PAIRS_PER_TASK = 2;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const rolloutsPath = argValue("--rollouts-json", DEFAULT_ROLLUPS_JSON);
const transcriptsPath = argValue("--transcripts", DEFAULT_TRANSCRIPTS_JSONL);
const outDir = argValue("--out-dir", DEFAULT_OUT_DIR);
const maxPairsPerTask = Number(argValue("--max-pairs-per-task", String(MAX_PAIRS_PER_TASK)));
if (!Number.isInteger(maxPairsPerTask) || maxPairsPerTask < 1) throw new Error("--max-pairs-per-task must be a positive integer");

const pairsPath = join(outDir, "dpo_pairs.jsonl");
const manifestPath = join(outDir, "manifest.json");

const rollouts = JSON.parse(readFileSync(rolloutsPath, "utf8"));
if (!Array.isArray(rollouts.rows)) throw new Error(`${rolloutsPath} has no rows[]`);
const splitCounts = new Map();
for (const row of rollouts.rows) {
  if (row.split !== "train") throw new Error(`refusing to mine non-train rollout for ${row.task_id}`);
  const current = splitCounts.get(row.task_id) ?? [];
  current.push(row);
  splitCounts.set(row.task_id, current);
}

const transcriptLines = readFileSync(transcriptsPath, "utf8").trim().split("\n").filter((line) => line.trim().length > 0);
const transcripts = new Map();
for (const [index, line] of transcriptLines.entries()) {
  const record = JSON.parse(line);
  if (record.split !== "train") throw new Error(`transcript line ${index + 1} is not train split`);
  if (typeof record.task_id !== "string" || typeof record.rollout_index !== "number" || !Array.isArray(record.messages)) {
    throw new Error(`transcript line ${index + 1} is missing task_id, rollout_index, or messages`);
  }
  transcripts.set(`${record.task_id}#${record.rollout_index}`, record);
}

function parseAction(text) {
  const visible = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
  const trimmed = visible.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let decoded;
  try {
    decoded = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
  if (name === "finish") return { finish: true };
  if (name !== "api_search" && name !== "api_fetch") return null;
  let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: args };
}

function replayState(taskId, transcript) {
  const { handle } = reset(taskId);
  for (const message of transcript.messages) {
    if (message.role !== "assistant") continue;
    const action = parseAction(message.content);
    if (!action) continue;
    if (action.finish) break;
    step(handle, action);
  }
  if (!handle.done) finish(handle);
  return canonicalJson(handle.state);
}

function pickPairsForTask(taskId, rows) {
  const transcriptByRollout = new Map();
  for (const row of rows) {
    const transcript = transcripts.get(`${taskId}#${row.rollout_index}`);
    if (!transcript) throw new Error(`missing transcript for ${taskId} rollout ${row.rollout_index}`);
    transcriptByRollout.set(row.rollout_index, transcript);
    if (transcript.split !== "train") throw new Error(`transcript split mismatch for ${taskId}`);
  }
  const scored = rows
    .map((row) => ({
      ...row,
      transcript: transcriptByRollout.get(row.rollout_index),
      stateSha256: replayState(taskId, transcriptByRollout.get(row.rollout_index)),
    }))
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.rollout_index - b.rollout_index);

  const passing = scored.filter((row) => row.score === 1);
  const failing = scored.filter((row) => typeof row.score === "number" && row.score < 1).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.rollout_index - b.rollout_index);
  const accepted = [];
  const usedRejected = new Set();
  for (const chosen of passing) {
    if (accepted.length >= maxPairsPerTask) break;
    const rejected = failing.find((candidate) => !usedRejected.has(candidate.rollout_index) && candidate.stateSha256 !== chosen.stateSha256);
    if (!rejected) continue;
    usedRejected.add(rejected.rollout_index);
    accepted.push({ chosen, rejected });
  }
  return accepted;
}

const pairsByBand = { bounded: [], extended: [], variable: [] };
for (const [taskId, rows] of [...splitCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const task = rows[0];
  const family = task.family ?? taskId.replace(/^oee-/, "").replace(/-\d{2}$/, "");
  const band = task.band ?? (family.includes("variable") ? "variable" : family.includes("extended") ? "extended" : "bounded");
  for (const pair of pickPairsForTask(taskId, rows)) {
    pairsByBand[band].push({
      task_id: taskId,
      split: "train",
      band,
      prompt_conversation: transcripts.get(`${taskId}#${pair.chosen.rollout_index}`).messages.filter((message) => message.role !== "tool").slice(0, 2),
      chosen: transcripts.get(`${taskId}#${pair.chosen.rollout_index}`).messages.filter((message) => message.role === "assistant"),
      rejected: transcripts.get(`${taskId}#${pair.rejected.rollout_index}`).messages.filter((message) => message.role === "assistant"),
      chosen_rollout_index: pair.chosen.rollout_index,
      rejected_rollout_index: pair.rejected.rollout_index,
      chosen_score: pair.chosen.score,
      rejected_score: pair.rejected.score,
    });
  }
}

const orderedPairs = [];
const bandOrder = ["bounded", "extended", "variable"];
while (bandOrder.some((band) => pairsByBand[band].length > 0)) {
  for (const band of bandOrder) {
    const next = pairsByBand[band].shift();
    if (next) orderedPairs.push(next);
  }
}

if (orderedPairs.length === 0) throw new Error("no usable pairs mined");

const pairLines = orderedPairs.map((row) => JSON.stringify({
  task_id: row.task_id,
  split: row.split,
  prompt_conversation: row.prompt_conversation,
  chosen: row.chosen,
  rejected: row.rejected,
}));
const pairsBody = `${pairLines.join("\n")}\n`;
mkdirSync(outDir, { recursive: true });
writeFileSync(pairsPath, pairsBody);
const pairsSha256 = createHash("sha256").update(pairsBody).digest("hex");
const bandCounts = orderedPairs.reduce((counts, row) => {
  counts[row.band] = (counts[row.band] ?? 0) + 1;
  return counts;
}, {});
const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  source: "synthetic-fixture-derived-rollouts",
  split: "train",
  fixture_id: WORKLOAD_OEE.fixture_id,
  train_split_sha256: oeeSplitSha256("train"),
  pairs_sha256: pairsSha256,
  pairs: orderedPairs.length,
  pairs_by_band: bandCounts,
  inputs: {
    rollouts_json: rolloutsPath,
    transcripts_jsonl: transcriptsPath,
  },
  max_pairs_per_task: maxPairsPerTask,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  pairs_path: pairsPath,
  manifest_path: manifestPath,
  pairs: orderedPairs.length,
  pairs_by_band: bandCounts,
  pairs_sha256: pairsSha256,
  train_split_sha256: manifest.train_split_sha256,
}, null, 2));
