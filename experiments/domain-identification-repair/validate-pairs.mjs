#!/usr/bin/env node
/**
 * Fail-closed gate for the `domain-identification` preference pairs before any
 * training spend. Same contract as `scripts/dpo-pairs-validate.mjs`, pinned to
 * this workload's slice fixture instead of the v2 fixture, and kept under the
 * workload's own path so the per-workload arms cannot collide.
 *
 *   1. INTEGRITY  — the manifest's `pairs_sha256` matches the bytes on disk.
 *   2. NO LEAKAGE — every task id exists in the slice and sits in TRAIN. One
 *      dev or holdout id fails the whole file.
 *   3. SYNTHETIC  — the manifest must declare a synthetic/fixture source and no
 *      row may carry a provider or tenant identifier.
 *   4. SIGNAL     — chosen must differ from rejected, and chosen must be the
 *      strictly better outcome.
 *
 * Emits the normalized JSONL that `scripts/tinker-dpo-train.py` consumes, so the
 * trainer is unreachable without passing this gate.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DOMAIN_ID_TASKS,
  domainIdFixtureSha256,
  domainIdSplitSha256,
  domainIdTaskBands,
} from "../../dist/domain-identification-slice.js";

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

const BANDS = domainIdTaskBands();
const SPLIT_BY_TASK = new Map(DOMAIN_ID_TASKS.map((task) => [task.taskId, task.split]));
const RUNTIME_FIXTURE_SHA256 = domainIdFixtureSha256();

/** Identifiers that must never reach a public training artifact. */
const PRIVATE_ID_PATTERNS = [
  /\borg_[0-9A-Za-z]{10,}\b/,
  /\bproj_[0-9a-f]{10,}\b/,
  /\bsk_[0-9A-Za-z]{16,}\b/,
  /\bsk-[0-9A-Za-z]{16,}\b/,
  /\bBearer\s+[0-9A-Za-z._-]{20,}/i,
  new RegExp(`\\b${["ce", "dar"].join("")}\\b`, "i"),
];

const failures = [];
const fail = (line, reason) => failures.push({ line, reason });

const raw = readFileSync(pairsPath);
const pairsSha256 = createHash("sha256").update(raw).digest("hex");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (typeof manifest.pairs_sha256 !== "string") fail(0, "manifest has no pairs_sha256");
else if (manifest.pairs_sha256 !== pairsSha256) fail(0, `manifest pairs_sha256 ${manifest.pairs_sha256} != file ${pairsSha256}`);
if (manifest.fixture_sha256 !== RUNTIME_FIXTURE_SHA256) {
  fail(0, "manifest fixture_sha256 missing/stale vs runtime fixture");
}

const declaredSource = String(manifest.source ?? manifest.data_source ?? "");
if (!/synthetic|public|fixture/i.test(declaredSource)) {
  fail(0, `manifest source must declare synthetic/public data (got ${JSON.stringify(declaredSource)})`);
}
if (manifest.split && manifest.split !== "train") fail(0, `manifest declares split ${manifest.split}; only train is trainable`);
if (manifest.train_split_sha256 && manifest.train_split_sha256 !== domainIdSplitSha256("train")) {
  fail(0, "manifest train_split_sha256 does not match this slice's frozen train split");
}
if (manifest.holdout_split_sha256 && manifest.holdout_split_sha256 !== domainIdSplitSha256("holdout")) {
  fail(0, "manifest holdout_split_sha256 does not match this slice's frozen holdout");
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

  if (row.fixture_sha256 !== RUNTIME_FIXTURE_SHA256) {
    fail(lineNumber, "row fixture_sha256 missing/stale");
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
  const split = SPLIT_BY_TASK.get(taskId);
  if (!split) {
    fail(lineNumber, `task_id ${taskId} is not in the domain-identification slice`);
    return;
  }
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
  if (typeof row.chosen_score === "number" && typeof row.rejected_score === "number" && row.chosen_score <= row.rejected_score) {
    return void fail(lineNumber, `chosen (${row.chosen_score}) does not beat rejected (${row.rejected_score})`);
  }

  const key = createHash("sha256").update(JSON.stringify([prompt, chosenText, rejectedText])).digest("hex");
  if (seen.has(key)) return void fail(lineNumber, "duplicate pair");
  seen.add(key);

  const family = row.family ?? taskId.replace(/^domain-id-/, "").replace(/-\d{2}$/, "");
  const band = BANDS[family] ?? "unknown";
  normalized.push({
    task_id: taskId,
    family,
    band,
    split,
    prompt_conversation: prompt,
    chosen,
    rejected,
    rejected_forbidden_writes: Number.isFinite(row.rejected_forbidden_writes)
      ? row.rejected_forbidden_writes
      : 0,
    fixture_sha256: RUNTIME_FIXTURE_SHA256,
    _line_index: lineNumber,
  });
});

if (normalized.length === 0) failures.push({ line: 0, reason: "no usable pairs" });

const familyCounts = (rows) => rows.reduce((counts, row) => {
  counts[row.family] = (counts[row.family] ?? 0) + 1;
  return counts;
}, {});
const familyCountsRaw = familyCounts(normalized);
let droppedForBalance = 0;
let balanceCapped = false;
const CAP = 0.35;

while (normalized.length > 0) {
  const counts = familyCounts(normalized);
  const [family, count] = Object.entries(counts)
    .sort(([leftFamily, leftCount], [rightFamily, rightCount]) =>
      rightCount - leftCount || leftFamily.localeCompare(rightFamily))
    [0];
  if (count <= Math.floor(CAP * normalized.length)) break;

  const others = normalized.length - count;
  const allowed = Math.floor((CAP / (1 - CAP)) * others);
  if (others === 0 || allowed < 1) {
    failures.push({ line: 0, reason: `skewed_family_unbalanceable: ${JSON.stringify(counts)}` });
    break;
  }

  const familyRows = normalized
    .filter((row) => row.family === family)
    .sort((left, right) =>
      left.task_id.localeCompare(right.task_id) || left._line_index - right._line_index);
  const dropRows = new Set(familyRows.slice(allowed).map((row) => row._line_index));
  normalized.splice(0, normalized.length, ...normalized.filter((row) => !dropRows.has(row._line_index)));
  droppedForBalance += count - allowed;
  balanceCapped = true;
}

const familyCountsFinal = familyCounts(normalized);
const bandCounts = normalized.reduce((counts, row) => {
  counts[row.band] = (counts[row.band] ?? 0) + 1;
  return counts;
}, {});
const normalizedOutput = normalized.map(({ _line_index, ...row }) => row);
const rejectedForbiddenWritesTotal = normalized.reduce(
  (total, row) => total + row.rejected_forbidden_writes,
  0,
);

const report = {
  schema_version: "understudy.dpo_pairs_validation.v1",
  generated_at: new Date().toISOString(),
  fixture_id: "domain-identification-offline-v1",
  pairs_path: pairsPath,
  manifest_path: manifestPath,
  pairs_sha256: pairsSha256,
  manifest_declared_sha256: manifest.pairs_sha256 ?? null,
  lines: lines.length,
  accepted: normalized.length,
  rejected: failures.length,
  split_counts: splitCounts,
  band_counts: bandCounts,
  family_counts_raw: familyCountsRaw,
  family_counts_final: familyCountsFinal,
  dropped_for_balance: droppedForBalance,
  balance_capped: balanceCapped,
  rejected_forbidden_writes_total: rejectedForbiddenWritesTotal,
  fixture_sha256: RUNTIME_FIXTURE_SHA256,
  train_split_sha256: domainIdSplitSha256("train"),
  holdout_split_sha256: domainIdSplitSha256("holdout"),
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
  writeFileSync(outPath, `${normalizedOutput.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
