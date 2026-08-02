#!/usr/bin/env node
/**
 * Fail-closed gate for a DPO preference-pair file before any training spend.
 *
 * The data-foundry arm emits near-hit preference pairs (`dpo_pairs.jsonl` plus a
 * manifest). Training on them is only safe if three things hold, and this script
 * refuses rather than repairs when any of them does not:
 *
 *   1. INTEGRITY — the manifest's `pairs_sha256` matches the file on disk, so the
 *      receipts name the bytes that were actually trained on.
 *   2. NO LEAKAGE — every referenced task id exists in this fixture and sits in
 *      the TRAIN split. A single dev or holdout id fails the whole file; the
 *      holdout is sealed and dev must stay an honest selection surface.
 *   3. SYNTHETIC ONLY — the pairs must declare a synthetic/public source and must
 *      not carry provider or tenant identifiers.
 *
 * Output is a normalized JSONL (prompt/chosen/rejected as message lists) that the
 * Tinker trainer consumes, so the trainer never has to guess at the input shape.
 *
 * Usage:
 *   node scripts/dpo-pairs-validate.mjs \
 *     --pairs data/dpo_pairs.jsonl --manifest data/dpo_pairs.manifest.json \
 *     --out outputs/dpo/pairs.normalized.jsonl \
 *     --report outputs/dpo/pairs.validation.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  MEETING_ORCHESTRATOR_SUBSET,
  TASKS,
  splitSha256,
  taskBands,
} from "../../dist/workloads/on-event-meeting-orchestrator/offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const pairsPath = argValue("--pairs");
const manifestPath = argValue("--manifest");
if (!pairsPath) throw new Error("--pairs is required");
if (!manifestPath) throw new Error("--manifest is required (a pair file with no manifest is not trainable)");
const outPath = argValue("--out");
const reportPath = argValue("--report");

const BANDS = taskBands();
const TASK_BY_ID = new Map(TASKS.map((task) => [task.taskId, task]));

/** Identifiers that must never reach a public training artifact. */
const PRIVATE_ID_PATTERNS = [
  /\borg_[0-9A-Za-z]{10,}\b/,
  /\bproj_[0-9a-f]{10,}\b/,
  /\bsk_[0-9A-Za-z]{16,}\b/,
  /\bsk-[0-9A-Za-z]{16,}\b/,
  /\bBearer\s+[0-9A-Za-z._-]{20,}/i,
];

const failures = [];
const fail = (line, reason) => failures.push({ line, reason });

const raw = readFileSync(pairsPath);
const pairsSha256 = createHash("sha256").update(raw).digest("hex");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (typeof manifest.pairs_sha256 !== "string") fail(0, "manifest has no pairs_sha256");
else if (manifest.pairs_sha256 !== pairsSha256) fail(0, `manifest pairs_sha256 ${manifest.pairs_sha256} != file ${pairsSha256}`);

const declaredSource = String(manifest.source ?? manifest.data_source ?? "");
if (!/synthetic|public|fixture/i.test(declaredSource)) {
  fail(0, `manifest source must declare synthetic/public data (got ${JSON.stringify(declaredSource)})`);
}
if (manifest.split && manifest.split !== "train") fail(0, `manifest declares split ${manifest.split}; only train is trainable`);
if (manifest.fixture_id !== MEETING_ORCHESTRATOR_SUBSET.fixture_id) {
  fail(0, `manifest fixture_id must be ${MEETING_ORCHESTRATOR_SUBSET.fixture_id}`);
}
if (typeof manifest.train_split_sha256 !== "string") {
  fail(0, "manifest has no train_split_sha256");
} else if (manifest.train_split_sha256 !== splitSha256("train")) {
  fail(0, "manifest train_split_sha256 does not match this fixture's frozen train split");
}

/** Accept a message list, a bare string, or {role,content}; reject anything else. */
function toMessages(value, role) {
  if (typeof value === "string") return [{ role, content: value }];
  if (Array.isArray(value)) {
    const messages = value.filter((item) => item && typeof item.role === "string" && typeof item.content === "string");
    return messages.length === value.length && messages.length > 0 ? messages : null;
  }
  if (value && typeof value.content === "string") return [{ role: value.role ?? role, content: value.content }];
  return null;
}

const lines = raw.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
const normalized = [];
const seen = new Set();
const bandCounts = {};
const splitCounts = {};

lines.forEach((line, index) => {
  const lineNumber = index + 1;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    fail(lineNumber, "line is not valid JSON");
    return;
  }

  for (const pattern of PRIVATE_ID_PATTERNS) {
    if (pattern.test(line)) {
      fail(lineNumber, `line carries a private-looking identifier (${pattern})`);
      return;
    }
  }

  const taskId = row.task_id ?? row.taskId ?? row.metadata?.task_id;
  if (typeof taskId !== "string") {
    fail(lineNumber, "row has no task_id; provenance to the fixture is required");
    return;
  }
  const task = TASK_BY_ID.get(taskId);
  if (!task) {
    fail(lineNumber, `task_id ${taskId} is not in the meeting orchestrator fixture`);
    return;
  }
  const split = task.split;
  splitCounts[split] = (splitCounts[split] ?? 0) + 1;
  if (split !== "train") {
    fail(lineNumber, `LEAKAGE: task_id ${taskId} belongs to the ${split} split`);
    return;
  }

  const prompt = toMessages(row.prompt_conversation ?? row.prompt ?? row.messages, "user");
  const chosen = toMessages(row.chosen ?? row.completion_chosen ?? row.preferred, "assistant");
  const rejected = toMessages(row.rejected ?? row.completion_rejected ?? row.dispreferred, "assistant");
  if (!prompt) return void fail(lineNumber, "row has no usable prompt/prompt_conversation/messages");
  if (!chosen) return void fail(lineNumber, "row has no usable chosen completion");
  if (!rejected) return void fail(lineNumber, "row has no usable rejected completion");

  const chosenText = chosen.map((message) => message.content).join("\n");
  const rejectedText = rejected.map((message) => message.content).join("\n");
  if (chosenText === rejectedText) return void fail(lineNumber, "chosen and rejected are identical; the pair carries no preference signal");

  const key = createHash("sha256").update(JSON.stringify([prompt, chosenText, rejectedText])).digest("hex");
  if (seen.has(key)) return void fail(lineNumber, "duplicate pair");
  seen.add(key);

  const family = task.family;
  const band = task.band ?? BANDS[family] ?? "unknown";
  bandCounts[band] = (bandCounts[band] ?? 0) + 1;
  normalized.push({ task_id: taskId, family, band, split, prompt_conversation: prompt, chosen, rejected });
});

if (normalized.length === 0) failures.push({ line: 0, reason: "no usable pairs" });

const report = {
  schema_version: "understudy.dpo_pairs_validation.v1",
  generated_at: new Date().toISOString(),
  pairs_path: pairsPath,
  manifest_path: manifestPath,
  pairs_sha256: pairsSha256,
  manifest_declared_sha256: manifest.pairs_sha256 ?? null,
  lines: lines.length,
  accepted: normalized.length,
  rejected: failures.length,
  split_counts: splitCounts,
  band_counts: bandCounts,
  fixture_id: MEETING_ORCHESTRATOR_SUBSET.fixture_id,
  holdout_split_sha256: splitSha256("holdout"),
  train_split_sha256: splitSha256("train"),
  failures: failures.slice(0, 50),
  verdict: failures.length === 0 ? "pass" : "fail",
};

if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));

if (failures.length > 0) {
  console.error(`\nrefusing to emit training data: ${failures.length} rejected row(s)`);
  process.exit(1);
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${normalized.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
