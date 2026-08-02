#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  GROUNDED_CHAT_FIXTURE,
  TASKS,
  auditTask,
  evaluateTask,
  fixtureSha256,
  nullAnswer,
  oracleAnswer,
  reset,
  splitCounts,
  splitSha256,
  splitsSha256,
  taskPool,
  validateFixture,
} from "../dist/grounded-chat-offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const outPath = argValue("--out", "experiments/wl-chat-repair/grounded-chat-freeze.json");
const asJson = process.argv.includes("--json");
const failures = [
  ...validateFixture(),
  ...TASKS.flatMap((task) => {
    const oracle = evaluateTask(task.taskId, oracleAnswer(task.taskId));
    const empty = evaluateTask(task.taskId, nullAnswer(task.taskId));
    const taskFailures = [];
    if (oracle.score !== 1 || oracle.fabrication || oracle.overBudget) {
      taskFailures.push(`${task.taskId}: oracle did not score 1.0`);
    }
    if (empty.score !== 0) taskFailures.push(`${task.taskId}: null answer did not score 0.0`);
    taskFailures.push(...auditTask(task));
    const first = JSON.stringify(reset(task.taskId));
    const second = JSON.stringify(reset(task.taskId));
    if (first !== second) taskFailures.push(`${task.taskId}: reset is not deterministic`);
    return taskFailures;
  }),
];

for (const split of ["train", "dev", "holdout"]) {
  const ids = taskPool({
    split,
    ...(split === "holdout" ? { frozenHoldoutSha256: splitSha256("holdout") } : {}),
  }).map((task) => task.taskId);
  if (new Set(ids).size !== ids.length) failures.push(`${split}: duplicate task ids`);
}
try {
  taskPool({ split: "holdout" });
  failures.push("holdout loader did not refuse without a frozen hash");
} catch {
  // Expected fail-closed behavior.
}

const hashes = {
  fixture_sha256: fixtureSha256(),
  train_sha256: splitSha256("train"),
  dev_sha256: splitSha256("dev"),
  holdout_sha256: splitSha256("holdout"),
  splits_sha256: splitsSha256(),
};
for (const [key, value] of Object.entries(hashes)) {
  if (value !== GROUNDED_CHAT_FIXTURE[key]) failures.push(`${key}: hash does not match the fixture pin`);
}

const oracleScores = TASKS.map((task) => evaluateTask(task.taskId, oracleAnswer(task.taskId)).score);
const nullScores = TASKS.map((task) => evaluateTask(task.taskId, nullAnswer(task.taskId)).score);
const report = {
  fixture: GROUNDED_CHAT_FIXTURE,
  counts: splitCounts(),
  hashes,
  gates: {
    oracle_mean: oracleScores.reduce((sum, value) => sum + value, 0) / oracleScores.length,
    oracle_min: Math.min(...oracleScores),
    null_max: Math.max(...nullScores),
    leakage_failures: TASKS.flatMap(auditTask),
    failures: [...new Set(failures)],
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`grounded-chat tasks: ${TASKS.length} (train ${report.counts.train} / dev ${report.counts.dev} / holdout ${report.counts.holdout})`);
  console.log(`fixture_sha256 : ${hashes.fixture_sha256}`);
  console.log(`train_sha256   : ${hashes.train_sha256}`);
  console.log(`dev_sha256     : ${hashes.dev_sha256}`);
  console.log(`holdout_sha256 : ${hashes.holdout_sha256}`);
  console.log(`splits_sha256  : ${hashes.splits_sha256}`);
  console.log(`oracle mean    : ${report.gates.oracle_mean.toFixed(4)}   null max: ${report.gates.null_max}`);
  console.log(`leakage errors : ${report.gates.leakage_failures.length}`);
}
if (report.gates.failures.length > 0) {
  for (const failure of report.gates.failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
}
