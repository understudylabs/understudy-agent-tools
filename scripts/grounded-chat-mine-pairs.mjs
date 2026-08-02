#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { TASKS } from "../dist/grounded-chat-offline.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) throw new Error(`${name} is required`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const rolloutsPath = argValue("--rollouts");
const pairsPath = argValue("--pairs");
const manifestPath = argValue("--manifest");
const artifact = JSON.parse(readFileSync(rolloutsPath, "utf8"));
if (artifact.split !== "train") throw new Error("pair mining requires a train-split rollout artifact");

const taskById = new Map(TASKS.map((task) => [task.taskId, task]));
const rowsByTask = new Map();
for (const row of artifact.rows ?? []) {
  if (!taskById.has(row.task_id)) throw new Error(`rollout task is not in the fixture: ${row.task_id}`);
  const rows = rowsByTask.get(row.task_id) ?? [];
  rows.push(row);
  rowsByTask.set(row.task_id, rows);
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function failureKind(row) {
  if (row.fabrication) return 0;
  if (row.over_budget) return 1;
  return 2;
}

function promptFor(task) {
  return `Workspace context:\n${task.context}\n\nQuestion: ${task.question}`;
}

const pairs = [];
const stats = {
  train_tasks: rowsByTask.size,
  tasks_with_pass: 0,
  tasks_with_fail: 0,
  tasks_with_signal: 0,
  skipped_no_pass: 0,
  skipped_no_fail: 0,
  skipped_identical: 0,
  pair_count: 0,
  failure_kinds: { fabrication: 0, over_budget: 0, missing_fact: 0 },
};

for (const task of TASKS.filter((candidate) => candidate.split === "train")) {
  const rows = rowsByTask.get(task.taskId) ?? [];
  const passing = rows.filter((row) => row.score === 1);
  const failing = rows.filter((row) => row.score < 1);
  if (passing.length > 0) stats.tasks_with_pass += 1;
  if (failing.length > 0) stats.tasks_with_fail += 1;
  if (passing.length === 0) {
    stats.skipped_no_pass += 1;
    continue;
  }
  if (failing.length === 0) {
    stats.skipped_no_fail += 1;
    continue;
  }

  const chosen = passing[0];
  const rejected = [...failing]
    .sort((left, right) => (
      failureKind(left) - failureKind(right)
      || (right.score ?? 0) - (left.score ?? 0)
      || String(left.answer).length - String(right.answer).length
    ))
    .find((candidate) => normalize(candidate.answer) !== normalize(chosen.answer));
  if (!rejected) {
    stats.skipped_identical += 1;
    continue;
  }

  const kind = failureKind(rejected);
  stats.failure_kinds[kind === 0 ? "fabrication" : kind === 1 ? "over_budget" : "missing_fact"] += 1;
  stats.tasks_with_signal += 1;
  stats.pair_count += 1;
  pairs.push({
    task_id: task.taskId,
    prompt_conversation: [{ role: "user", content: promptFor(task) }],
    chosen: [{ role: "assistant", content: chosen.answer }],
    rejected: [{ role: "assistant", content: rejected.answer }],
  });
}

if (pairs.length === 0) {
  throw new Error(`no outcome-changing preference pairs mined: ${JSON.stringify(stats)}`);
}

const body = `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
const pairsSha256 = createHash("sha256").update(body).digest("hex");
const manifest = {
  schema_version: "understudy.dpo_pairs_manifest.v1",
  fixture_id: "grounded-chat-offline-v1",
  source: "grounded-chat-offline-v1 synthetic fixture",
  split: "train",
  train_split_sha256: artifact.split_sha256,
  pairs_sha256: pairsSha256,
  pair_count: pairs.length,
  mining: stats,
};

mkdirSync(dirname(pairsPath), { recursive: true });
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(pairsPath, body);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ...stats, pairs_sha256: pairsSha256 }, null, 2));
