#!/usr/bin/env node
/**
 * Mine balanced, outcome-changing DPO pairs from a recorded multi-sample run.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getTask } from "../../dist/workloads/on-event-meeting-orchestrator/offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const runPath = argValue("--run");
const pairsPath = argValue("--out", "dpo_pairs.jsonl");
const manifestPath = argValue("--manifest", `${pairsPath}.manifest.json`);
const maxPerTask = Math.max(1, Number(argValue("--max-pairs-per-task", "2")) || 2);
if (!runPath) throw new Error("--run is required");

const run = JSON.parse(readFileSync(runPath, "utf8"));
if (!Array.isArray(run.rows)) throw new Error("--run must contain rows[]");
if (run.split !== "train") throw new Error("DPO mining requires a train run");

const canonical = (value) => JSON.stringify(value);
const assistantMessages = (row) => {
  if (!Array.isArray(row.trajectory)) return null;
  const messages = row.trajectory.filter((message) => message?.role === "assistant" && typeof message.content === "string");
  return messages.length ? messages : null;
};
function parseEffectiveAction(content) {
  const visible = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const start = visible.indexOf("{");
  const end = visible.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const decoded = JSON.parse(visible.slice(start, end + 1));
    const name = decoded.tool ?? decoded.name ?? decoded.function?.name;
    let args = decoded.arguments ?? decoded.args ?? decoded.function?.arguments ?? {};
    if (typeof args === "string") args = JSON.parse(args);
    return { name, arguments: args };
  } catch {
    return null;
  }
}
const effectiveSequence = (row) => {
  const messages = assistantMessages(row) ?? [];
  return messages.map((message) => parseEffectiveAction(message.content));
};
function firstDivergence(chosen, rejected) {
  const chosenMessages = assistantMessages(chosen) ?? [];
  const rejectedMessages = assistantMessages(rejected) ?? [];
  const length = Math.max(chosenMessages.length, rejectedMessages.length);
  for (let index = 0; index < length; index += 1) {
    if (canonical(parseEffectiveAction(chosenMessages[index]?.content ?? "")) !==
        canonical(parseEffectiveAction(rejectedMessages[index]?.content ?? ""))) {
      return {
        index,
        chosen: chosenMessages[index] ?? null,
        rejected: rejectedMessages[index] ?? null,
        prompt: chosen.trajectory.slice(0, chosen.trajectory.indexOf(chosenMessages[index])),
      };
    }
  }
  return null;
}

const byTask = new Map();
for (const row of run.rows) {
  if (typeof row.task_id !== "string" || row.sample_index === undefined) continue;
  const task = getTask(row.task_id);
  if (task.split !== "train") continue;
  const taskRows = byTask.get(row.task_id) ?? [];
  taskRows.push(row);
  byTask.set(row.task_id, taskRows);
}

const candidates = [];
let droppedCosmetic = 0;
const allBands = new Set();
for (const [taskId, rows] of byTask) {
  allBands.add(getTask(taskId).band);
  const chosen = rows.filter((row) => row.score === 1 && (row.forbidden_effects ?? 0) === 0 && assistantMessages(row));
  const rejected = rows.filter((row) =>
    assistantMessages(row) &&
    ((row.score > 0 && row.score < 1) || (row.score === 0 && ((row.over_acting || row.forbidden_effects > 0)))),
  );
  const task = getTask(taskId);
  for (const winner of chosen) {
    for (const loser of rejected) {
      if (canonical(effectiveSequence(winner)) === canonical(effectiveSequence(loser))) {
        droppedCosmetic += 1;
        continue;
      }
      const divergence = firstDivergence(winner, loser);
      if (!divergence?.chosen || !divergence.rejected) continue;
      candidates.push({
        task,
        chosen: winner,
        rejected: loser,
        divergence,
        tier: "exact",
        band: task.band,
      });
    }
  }
}

const byBand = new Map();
for (const candidate of candidates) {
  const bandRows = byBand.get(candidate.band) ?? [];
  bandRows.push(candidate);
  byBand.set(candidate.band, bandRows);
}
const perTask = new Map();
const selected = [];
let progress = true;
while (progress) {
  progress = false;
  for (const bucket of byBand.values()) {
    while (bucket.length) {
      const candidate = bucket.shift();
      const count = perTask.get(candidate.task.taskId) ?? 0;
      if (count >= maxPerTask) continue;
      perTask.set(candidate.task.taskId, count + 1);
      selected.push(candidate);
      progress = true;
      break;
    }
  }
}

// If a band has no exact-1 preference signal, retain a documented graded tier:
// the highest-scoring zero-forbidden rollout beats a strictly lower sibling.
const selectedBands = new Set(selected.map((candidate) => candidate.band));
for (const band of allBands) {
  if (selectedBands.has(band)) continue;
  for (const [taskId, rows] of byTask) {
    const task = getTask(taskId);
    if (task.band !== band) continue;
    const eligible = rows
      .filter((row) => typeof row.score === "number" && (row.forbidden_effects ?? 0) === 0 && assistantMessages(row))
      .sort((left, right) => right.score - left.score);
    if (eligible.length < 2 || eligible[0].score <= eligible[1].score) continue;
    const winner = eligible[0];
    const loser = eligible.find((row) => row.score < winner.score);
    if (!loser) continue;
    if (canonical(effectiveSequence(winner)) === canonical(effectiveSequence(loser))) {
      droppedCosmetic += 1;
      continue;
    }
    const divergence = firstDivergence(winner, loser);
    if (!divergence?.chosen || !divergence.rejected) continue;
    candidates.push({ task, chosen: winner, rejected: loser, divergence, tier: "graded", band });
  }
}

const fallbackBands = new Set(candidates.filter((candidate) => candidate.tier === "graded").map((candidate) => candidate.band));

const selectedWithTier = [...selected];
for (const band of fallbackBands) {
  const bucket = candidates.filter((candidate) => candidate.tier === "graded" && candidate.band === band);
  const count = new Map();
  for (const candidate of bucket) {
    const taskCount = count.get(candidate.task.taskId) ?? 0;
    if (taskCount >= maxPerTask) continue;
    count.set(candidate.task.taskId, taskCount + 1);
    selectedWithTier.push(candidate);
  }
}
const lines = selectedWithTier.map(({ task, divergence, tier }) => JSON.stringify({
  task_id: task.taskId,
  family: task.family,
  band: task.band,
  split: task.split,
  prompt_conversation: divergence.prompt,
  chosen: [divergence.chosen],
  rejected: [divergence.rejected],
  tier,
}));
const body = `${lines.length ? `${lines.join("\n")}\n` : ""}`;
const pairsSha256 = createHash("sha256").update(body).digest("hex");
const manifest = {
  schema_version: "understudy.wl_meeting_orchestrator_dpo_manifest.v1",
  source: "synthetic-offline-fixture",
  split: "train",
  fixture_id: run.fixture_id ?? "meeting-orchestrator-shapes-offline-v1",
  train_split_sha256: run.split_sha256,
  pairs_sha256: pairsSha256,
  pair_count: selectedWithTier.length,
  dropped_cosmetic_only: droppedCosmetic,
  band_counts: Object.fromEntries(selectedWithTier.reduce((counts, row) => counts.set(row.band, (counts.get(row.band) ?? 0) + 1), new Map())),
  tier_counts: Object.fromEntries(selectedWithTier.reduce((counts, row) => counts.set(row.tier, (counts.get(row.tier) ?? 0) + 1), new Map())),
};

mkdirSync(dirname(pairsPath), { recursive: true });
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(pairsPath, body);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ...manifest, pairs_path: pairsPath, manifest_path: manifestPath }, null, 2));
