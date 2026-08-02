#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ANALYZER_TASKS } from "../dist/analyzer-slice.js";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
};
const runPath = arg("--run");
const outPath = arg("--out");
const manifestPath = arg("--manifest");
const maxPerTask = Number(arg("--max-per-task", "3"));
const seed = Number(arg("--seed", "7"));
if (!runPath || !outPath || !manifestPath) throw new Error("--run, --out, and --manifest are required");
if (!Number.isInteger(maxPerTask) || maxPerTask < 1) throw new Error("--max-per-task must be a positive integer");

const run = JSON.parse(readFileSync(runPath, "utf8"));
if (run.split !== "train") throw new Error("refusing to mine pairs from a non-train run");
if (!Array.isArray(run.rows)) throw new Error("run artifact has no rows[]");
const taskMap = new Map(ANALYZER_TASKS.map((task) => [task.taskId, task]));
const groups = new Map();
for (const row of run.rows) {
  const task = taskMap.get(row.task_id);
  if (!task) continue;
  if (!groups.has(row.task_id)) groups.set(row.task_id, []);
  groups.get(row.task_id).push(row);
}
const hashRandom = (text) => {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
};
const reasonOf = (row) => row.forbidden?.includes("over_claim") ? "over_claim"
  : row.forbidden?.includes("hallucinated_citation") ? "hallucinated_citation"
    : row.forbidden?.includes("invalid_output") ? "invalid_output"
      : null;
const rank = (row) => row.score > 0 && row.score < 1 ? 0 : reasonOf(row) === "over_claim" ? 1 : reasonOf(row) === "hallucinated_citation" ? 2 : 3;
const pairs = [];
const rejectionCounts = {};
const bandCounts = {};
for (const [taskId, rows] of groups) {
  const chosen = rows.find((row) => row.score === 1 && typeof row.raw_output === "string" && row.raw_output.length > 0);
  if (!chosen) continue;
  const rejected = rows.filter((row) => row !== chosen && (rank(row) < 3 || row.score === 0))
    .sort((a, b) => rank(a) - rank(b) || hashRandom(`${taskId}:${a.sample_index}`) - hashRandom(`${taskId}:${b.sample_index}`));
  const selected = [];
  const overClaim = rejected.find((row) => reasonOf(row) === "over_claim");
  const nearMisses = rejected.filter((row) => row.score > 0 && row.score < 1);
  if (overClaim && maxPerTask === 1) selected.push(overClaim);
  else {
    for (const row of nearMisses.slice(0, overClaim ? maxPerTask - 1 : maxPerTask)) selected.push(row);
    if (overClaim && selected.length < maxPerTask) selected.push(overClaim);
    for (const row of rejected) if (!selected.includes(row) && selected.length < maxPerTask) selected.push(row);
  }
  for (const row of selected.slice(0, maxPerTask)) {
    if (chosen.raw_output === row.raw_output) continue;
    const reason = reasonOf(row) ?? (row.score > 0 ? `near_hit_${row.score}` : "zero");
    rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    bandCounts[taskMap.get(taskId).band] = (bandCounts[taskMap.get(taskId).band] ?? 0) + 1;
    pairs.push({
      task_id: taskId,
      prompt_conversation: chosen.prompt_conversation,
      chosen: [{ role: "assistant", content: chosen.raw_output }],
      rejected: [{ role: "assistant", content: row.raw_output }],
      rejection_reason: reason,
      band: taskMap.get(taskId).band,
    });
  }
}
const deduped = [...new Map(pairs.map((pair) => {
  const key = createHash("sha256").update(JSON.stringify([pair.task_id, pair.prompt_conversation, pair.chosen, pair.rejected])).digest("hex");
  return [key, pair];
})).values()];
if (deduped.length === 0) throw new Error("no usable chosen/rejected pairs found");
const body = `${deduped.map((pair) => JSON.stringify(pair)).join("\n")}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);
const pairsSha256 = createHash("sha256").update(body).digest("hex");
const manifest = {
  schema_version: "understudy.analyzer_dpo_manifest.v1",
  source: "synthetic analyzer offline fixture",
  split: "train",
  fixture_id: "analyzer-verdict-offline-v1",
  train_split_sha256: run.split_sha256,
  pairs_sha256: pairsSha256,
  pair_count: deduped.length,
  band_counts: bandCounts,
  rejection_reason_counts: rejectionCounts,
};
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ pairs_path: outPath, manifest_path: manifestPath, ...manifest }, null, 2));
