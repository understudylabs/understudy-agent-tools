import { writeFileSync } from "node:fs";

import {
  FROZEN_HOLDOUT_SHA256,
  FROZEN_FIXTURE_SHA256,
  FROZEN_TRAIN_SHA256,
  FROZEN_DEV_SHA256,
  TASKS,
  fixtureSha256,
  oraclePolicy,
  rollout,
  sentinelPolicy,
  splitCounts,
  splitSha256,
  taskBands,
  taskPool,
} from "../../dist/workloads/on-event-meeting-orchestrator/offline.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const failures = [];
const oracleResults = TASKS.map((task) => rollout(task.taskId, oraclePolicy(task.taskId)));
const sentinelResults = TASKS.map((task) => rollout(task.taskId, sentinelPolicy()));
const lazyResults = TASKS.map((task) => rollout(task.taskId, () => null));

for (const result of oracleResults) {
  if (result.reward !== 1 || result.forbiddenEffects.length) failures.push(`oracle failed: ${result.taskId}`);
  if (result.leakage.length) failures.push(`leakage: ${result.taskId}: ${result.leakage.join("; ")}`);
}
for (const result of sentinelResults) {
  if (result.reward !== 0) failures.push(`sentinel failed: ${result.taskId}`);
}
for (const result of lazyResults) {
  if (result.reward !== 0) failures.push(`lazy policy failed: ${result.taskId}`);
}
try { taskPool({ split: "holdout" }); failures.push("unpinned holdout read succeeded"); } catch {}
try { taskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }); failures.push("mismatched holdout read succeeded"); } catch {}
try {
  if (taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") }).length !== 32) failures.push("holdout count mismatch");
} catch (error) { failures.push(`exact holdout read failed: ${error.message}`); }
if (FROZEN_HOLDOUT_SHA256 !== splitSha256("holdout")) failures.push("pinned holdout hash mismatch");
if (FROZEN_FIXTURE_SHA256 !== fixtureSha256()) failures.push("pinned fixture hash mismatch");
if (FROZEN_TRAIN_SHA256 !== splitSha256("train")) failures.push("pinned train hash mismatch");
if (FROZEN_DEV_SHA256 !== splitSha256("dev")) failures.push("pinned dev hash mismatch");

const bandCounts = {};
for (const task of TASKS) bandCounts[taskBands()[task.family]] = (bandCounts[taskBands()[task.family]] ?? 0) + 1;

const report = {
  fixture_id: "meeting-orchestrator-shapes-offline-v1",
  fixture_sha256: fixtureSha256(),
  split_sha256: { train: splitSha256("train"), dev: splitSha256("dev"), holdout: splitSha256("holdout") },
  counts: splitCounts(),
  task_count: TASKS.length,
  band_counts: bandCounts,
  gates: {
    oracle_mean: oracleResults.reduce((sum, result) => sum + result.reward, 0) / TASKS.length,
    sentinel_max: Math.max(...sentinelResults.map((result) => result.reward)),
    lazy_max: Math.max(...lazyResults.map((result) => result.reward)),
    failures,
  },
};

if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`meeting orchestrator tasks: ${TASKS.length} (train ${report.counts.train} / dev ${report.counts.dev} / holdout ${report.counts.holdout})`);
  console.log(`fixture_sha256: ${report.fixture_sha256}`);
  console.log(`train_sha256: ${report.split_sha256.train}`);
  console.log(`dev_sha256: ${report.split_sha256.dev}`);
  console.log(`holdout_sha256: ${report.split_sha256.holdout}`);
  console.log(`oracle_mean: ${report.gates.oracle_mean}; sentinel_max: ${report.gates.sentinel_max}`);
}
if (failures.length) process.exitCode = 1;
