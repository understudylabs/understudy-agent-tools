#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ANALYZER_SEVERITIES,
  ANALYZER_SIGNALS,
  ANALYZER_STATUSES,
  ANALYZER_TASKS,
  analyzerFixtureSha256,
  analyzerSplitSha256,
  analyzerTaskBands,
  analyzerTaskPool,
  canonicalJson,
  constantPolicy,
  nullPolicy,
  oraclePolicy,
  scoreVerdict,
  sentinelPolicy,
  sha256,
} from "../dist/analyzer-slice.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];
if (outIndex !== -1 && (!outPath || outPath.startsWith("--"))) throw new Error("--out requires a path");

const failures = [];
const recordFailure = (message) => failures.push(message);
const scoresFor = (policy) => ANALYZER_TASKS.map((task) => scoreVerdict(task, policy(task)));

const oracleScores = scoresFor((task) => oraclePolicy(task.taskId)(task));
const sentinelScores = scoresFor((task) => sentinelPolicy()(task));
const nullScores = scoresFor((task) => nullPolicy()(task));

oracleScores.forEach((result, index) => {
  if (result.score !== 1 || result.forbidden.length > 0) recordFailure(`oracle failed on ${ANALYZER_TASKS[index].taskId}`);
});
sentinelScores.forEach((result, index) => {
  if (result.score !== 0) recordFailure(`sentinel scored ${result.score} on ${ANALYZER_TASKS[index].taskId}`);
});
nullScores.forEach((result, index) => {
  if (result.score !== 0) recordFailure(`null policy scored ${result.score} on ${ANALYZER_TASKS[index].taskId}`);
});

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const exactRate = (values) => values.filter((value) => value === 1).length / values.length;
const fieldModes = (field) => {
  const counts = new Map();
  for (const task of ANALYZER_TASKS) {
    const value = field === "citations" ? canonicalJson(task.gold.citations) : task.gold[field];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const mostCommon = {
  status: fieldModes("status"),
  severity: fieldModes("severity"),
  primary_signal: fieldModes("primary_signal"),
  citations: JSON.parse(fieldModes("citations")),
};
const trivialVerdicts = [
  mostCommon,
  {
    status: "insufficient_evidence",
    severity: "none",
    primary_signal: "no_signal",
    citations: [],
  },
];
const trivial = trivialVerdicts.map((verdict) => {
  const scores = scoresFor(() => constantPolicy(verdict)({}));
  return { verdict, mean_score: mean(scores.map((result) => result.score)), exact_1_rate: exactRate(scores.map((result) => result.score)) };
});
for (const [index, result] of trivial.entries()) {
  if (!(result.mean_score < 0.5 && result.exact_1_rate < 0.2)) recordFailure(`trivial floor failed for arm ${index}`);
}

const vocabulary = [...ANALYZER_STATUSES, ...ANALYZER_SEVERITIES, ...ANALYZER_SIGNALS];
const normalizeWords = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const normalizeCompact = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const dateFromEvidence = (text) => {
  const match = /([A-Z][a-z]+ \d{1,2}, 2026)/.exec(text);
  return match ? Date.parse(match[1]) : NaN;
};
const bands = analyzerTaskBands();
const normalizedPrompts = new Set(ANALYZER_TASKS.map((task) => task.prompt.replace(/for the [A-Za-z]+ workstream/, "for the {workstream} workstream")));
if (normalizedPrompts.size !== 1) recordFailure(`prompt instruction is not byte-identical after workstream normalization (${normalizedPrompts.size} variants)`);

const tripleCounts = new Map();
let upperHalfCitationTasks = 0;
for (const task of ANALYZER_TASKS) {
  const candidateText = task.evidence.map((item) => item.text).join("\n");
  const wordText = `_${normalizeWords(candidateText)}_`;
  const compactText = normalizeCompact(candidateText);
  for (const token of vocabulary) {
    if (wordText.includes(`_${normalizeWords(token)}_`)) recordFailure(`vocabulary leakage: ${token} in ${task.taskId}`);
  }
  for (const [family, band] of Object.entries(bands)) {
    if (compactText.includes(normalizeCompact(family))) recordFailure(`family leakage: ${family} in ${task.taskId}`);
    if (compactText.includes(normalizeCompact(band))) recordFailure(`band leakage: ${band} in ${task.taskId}`);
  }
  for (const citation of task.gold.citations) {
    const index = task.evidence.findIndex((item) => item.id === citation);
    if (index < 0) recordFailure(`unreachable citation ${citation} on ${task.taskId}`);
    else {
      if (index >= Math.ceil(task.evidence.length / 2)) upperHalfCitationTasks += 1;
      const workstream = /for the ([A-Za-z]+) workstream/.exec(task.prompt)?.[1];
      if (!workstream || !task.evidence[index].text.includes(workstream)) recordFailure(`cited evidence does not name workstream on ${task.taskId}: ${citation}`);
    }
  }
  if (task.family === "recency-conflict" || task.family === "superseded-record") {
    const dates = task.gold.citations.map((citation) => dateFromEvidence(task.evidence.find((item) => item.id === citation)?.text ?? ""));
    if (!dates.every(Number.isFinite) || dates[1] <= dates[0]) recordFailure(`conflict dates are not ordered on ${task.taskId}`);
  }
  if (task.prompt.includes(task.gold.citations[0])) recordFailure(`prompt exposes citation on ${task.taskId}`);
  if (JSON.stringify(task.gold).length > 400) recordFailure(`gold verdict exceeds 400 characters on ${task.taskId}`);
  const triple = canonicalJson([task.gold.status, task.gold.severity, task.gold.primary_signal]);
  tripleCounts.set(triple, (tripleCounts.get(triple) ?? 0) + 1);
}
if (upperHalfCitationTasks / ANALYZER_TASKS.length < 0.3) recordFailure(`too few tasks cite upper-half evidence indices: ${upperHalfCitationTasks}/${ANALYZER_TASKS.length}`);
const goldVerdictDistribution = [...tripleCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([triple, count]) => {
    const [status, severity, primary_signal] = JSON.parse(triple);
    return { status, severity, primary_signal, count };
  });
const dominantTriple = Math.max(...tripleCounts.values()) / ANALYZER_TASKS.length;
if (dominantTriple > 0.4) recordFailure(`gold verdict triple concentration ${(dominantTriple * 100).toFixed(1)}% exceeds 40%`);

const ids = new Set();
const evidenceHashes = new Map();
for (const task of ANALYZER_TASKS) {
  if (ids.has(task.taskId)) recordFailure(`duplicate task id ${task.taskId}`);
  ids.add(task.taskId);
  const bundleHash = sha256(task.evidence);
  const previous = evidenceHashes.get(bundleHash);
  if (previous && previous.split !== task.split) recordFailure(`evidence bundle crosses splits: ${previous.taskId} / ${task.taskId}`);
  evidenceHashes.set(bundleHash, task);
}

const splitHashes = Object.fromEntries(["train", "dev", "holdout"].map((split) => [split, analyzerSplitSha256(split)]));
const repeatedSplitHashes = Object.fromEntries(["train", "dev", "holdout"].map((split) => [split, analyzerSplitSha256(split)]));
if (canonicalJson(splitHashes) !== canonicalJson(repeatedSplitHashes)) recordFailure("split hashes changed between rebuilds");

try {
  analyzerTaskPool({ split: "holdout" });
  recordFailure("holdout pool readable without frozen hash");
} catch {
  // Expected.
}
try {
  analyzerTaskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) });
  recordFailure("holdout pool readable with wrong frozen hash");
} catch {
  // Expected.
}
const holdout = analyzerTaskPool({ split: "holdout", frozenHoldoutSha256: splitHashes.holdout });
if (holdout.length !== 36) recordFailure(`holdout count was ${holdout.length}, expected 36`);

const counts = ANALYZER_TASKS.reduce((result, task) => {
  result[task.split] += 1;
  return result;
}, { train: 0, dev: 0, holdout: 0 });
const report = {
  fixture_id: "analyzer-verdict-offline-v1",
  fixture_sha256: analyzerFixtureSha256(),
  split_sha256: splitHashes,
  counts,
  bands: analyzerTaskBands(),
  gates: {
    oracle_mean: mean(oracleScores.map((result) => result.score)),
    oracle_exact_1_rate: exactRate(oracleScores.map((result) => result.score)),
    sentinel_max: Math.max(...sentinelScores.map((result) => result.score)),
    null_max: Math.max(...nullScores.map((result) => result.score)),
    trivial,
    upper_half_citation_tasks: upperHalfCitationTasks,
    gold_verdict_distribution: goldVerdictDistribution,
    dominant_triple_rate: dominantTriple,
    failures,
  },
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`analyzer tasks: ${ANALYZER_TASKS.length} (train ${counts.train} / dev ${counts.dev} / holdout ${counts.holdout})`);
  console.log(`fixture_sha256 : ${report.fixture_sha256}`);
  console.log(`train_sha256   : ${splitHashes.train}`);
  console.log(`dev_sha256     : ${splitHashes.dev}`);
  console.log(`holdout_sha256 : ${splitHashes.holdout}`);
  console.log(`oracle mean    : ${report.gates.oracle_mean.toFixed(4)}   sentinel max: ${report.gates.sentinel_max}`);
}

if (failures.length > 0) {
  console.error(`\nGATE FAILURES (${failures.length}):`);
  for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
  process.exit(1);
}
