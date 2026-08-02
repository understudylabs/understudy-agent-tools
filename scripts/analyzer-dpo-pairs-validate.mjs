#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ANALYZER_TASKS, analyzerSplitSha256 } from "../dist/analyzer-slice.js";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
};
const pairsPath = arg("--pairs");
const manifestPath = arg("--manifest");
const outPath = arg("--out");
const reportPath = arg("--report");
if (!pairsPath || !manifestPath) throw new Error("--pairs and --manifest are required");

const taskMap = new Map(ANALYZER_TASKS.map((task) => [task.taskId, task]));
const raw = readFileSync(pairsPath);
const pairsSha256 = createHash("sha256").update(raw).digest("hex");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const fail = (line, reason) => failures.push({ line, reason });
if (manifest.pairs_sha256 !== pairsSha256) fail(0, `manifest pairs_sha256 ${manifest.pairs_sha256} != file ${pairsSha256}`);
if (!/synthetic|public|fixture/i.test(String(manifest.source ?? ""))) fail(0, "manifest source must declare synthetic/public data");
if (manifest.split !== "train") fail(0, `manifest split must be train (got ${manifest.split})`);
if (manifest.fixture_id !== "analyzer-verdict-offline-v1") fail(0, "manifest fixture_id does not match analyzer fixture");
if (manifest.train_split_sha256 !== analyzerSplitSha256("train")) fail(0, "manifest train split hash mismatch");

const privatePatterns = [/\b(?:org|proj|usp)_[A-Za-z0-9]{10,}\b/, /\bsk[-_][A-Za-z0-9]{16,}\b/, /\bBearer\s+[A-Za-z0-9._-]{20,}/i];
const toMessages = (value, role) => {
  if (typeof value === "string") return [{ role, content: value }];
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => item && typeof item.role === "string" && typeof item.content === "string") ? value : null;
};
const normalized = [];
const seen = new Set();
const lines = raw.toString("utf8").split("\n").filter((line) => line.trim());
const bandCounts = {};
const splitCounts = {};
lines.forEach((line, index) => {
  let row;
  try { row = JSON.parse(line); } catch { fail(index + 1, "line is not valid JSON"); return; }
  if (privatePatterns.some((pattern) => pattern.test(line))) { fail(index + 1, "line carries a private-looking identifier"); return; }
  const task = taskMap.get(row.task_id);
  if (!task) { fail(index + 1, `task_id ${row.task_id} is not in the analyzer fixture`); return; }
  splitCounts[task.split] = (splitCounts[task.split] ?? 0) + 1;
  if (task.split !== "train") { fail(index + 1, `LEAKAGE: task_id ${task.taskId} belongs to ${task.split}`); return; }
  const prompt = toMessages(row.prompt_conversation ?? row.prompt, "user");
  const chosen = toMessages(row.chosen, "assistant");
  const rejected = toMessages(row.rejected, "assistant");
  if (!prompt) { fail(index + 1, "row has no usable prompt_conversation"); return; }
  if (!chosen || !rejected) { fail(index + 1, "row has no usable list-valued chosen/rejected completion"); return; }
  const chosenText = chosen.map((item) => item.content).join("\n");
  const rejectedText = rejected.map((item) => item.content).join("\n");
  if (chosenText === rejectedText) { fail(index + 1, "chosen and rejected are identical"); return; }
  const key = createHash("sha256").update(JSON.stringify([task.taskId, prompt, chosenText, rejectedText])).digest("hex");
  if (seen.has(key)) { fail(index + 1, "duplicate pair"); return; }
  seen.add(key);
  bandCounts[task.band] = (bandCounts[task.band] ?? 0) + 1;
  normalized.push({ task_id: task.taskId, family: task.family, band: task.band, split: task.split, prompt_conversation: prompt, chosen, rejected });
});
if (normalized.length === 0) failures.push({ line: 0, reason: "no usable pairs" });
const report = {
  schema_version: "understudy.analyzer_dpo_validation.v1",
  pairs_sha256: pairsSha256, manifest_declared_sha256: manifest.pairs_sha256 ?? null,
  accepted: normalized.length, rejected: failures.length, split_counts: splitCounts, band_counts: bandCounts,
  train_split_sha256: analyzerSplitSha256("train"), holdout_split_sha256: analyzerSplitSha256("holdout"),
  failures: failures.slice(0, 50), verdict: failures.length ? "fail" : "pass",
};
if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
if (outPath) { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, `${normalized.map((row) => JSON.stringify(row)).join("\n")}\n`); }
