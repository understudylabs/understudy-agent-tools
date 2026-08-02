#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  GUARD_CONTACT,
  assertionPath,
  assertionSatisfied,
  oraclePolicy,
  sentinelPolicy,
  rollout as sharedRollout,
} from "../../../dist/automationbench-offline.js";
import {
  TASKS,
  discoverableText,
  deterministicTaskHash,
  fixtureSha256,
  splitCounts,
  splitManifest,
  splitSha256,
  taskPool,
} from "../src/wl07-fixture.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];

const failures = [];
const oracleScores = [];
const sentinelScores = [];

for (const task of TASKS) {
  const oracle = sharedRollout(task.taskId, oraclePolicy(task.taskId));
  oracleScores.push(oracle.reward);
  if (oracle.reward !== 1) failures.push(`oracle scored ${oracle.reward} on ${task.taskId}`);
  if (oracle.forbiddenEffects.length > 0) failures.push(`oracle forbidden effects on ${task.taskId}: ${oracle.forbiddenEffects.join(", ")}`);
  if (oracle.leakage.length > 0) failures.push(`observation leakage on ${task.taskId}: ${oracle.leakage.join("; ")}`);

  const sentinel = sharedRollout(task.taskId, sentinelPolicy());
  sentinelScores.push(sentinel.reward);
  if (sentinel.reward !== 0) failures.push(`sentinel scored ${sentinel.reward} on ${task.taskId}`);

  if (task.assertions.every((assertion) => assertionSatisfied(task.initialState, assertion))) {
    failures.push(`task is pre-satisfied at reset: ${task.taskId}`);
  }
  if (task.allowedWrites.some((write) => write.includes(`contacts.${GUARD_CONTACT.id}`))) {
    failures.push(`task may write guard contact: ${task.taskId}`);
  }

  const text = discoverableText(task);
  for (const call of task.oracle) {
    const args = call.arguments;
    const literals = [];
    if (typeof args.url === "string") {
      const segments = args.url.split("/").filter(Boolean);
      if (segments.length > 2) literals.push(segments[2]);
    }
    for (const value of Object.values(args.body ?? {})) {
      if (typeof value === "string") literals.push(value);
    }
    for (const literal of literals) {
      const parts = literal.split(/\s+/).filter((part) => part.length > 1);
      if (!text.includes(literal) && !(parts.length > 1 && parts.every((part) => text.includes(part)))) {
        failures.push(`unreachable oracle literal on ${task.taskId}: ${literal}`);
      }
    }
  }
  for (const assertion of task.assertions) {
    if (task.prompt.includes(assertionPath(assertion))) failures.push(`assertion path in prompt on ${task.taskId}`);
  }
}

const bySplit = Object.fromEntries(["train", "dev", "holdout"].map((split) => [split, new Set(taskPool({
  split,
  frozenHoldoutSha256: split === "holdout" ? splitSha256("holdout") : undefined,
}).map((task) => task.taskId))]));
const allIds = [...bySplit.train, ...bySplit.dev, ...bySplit.holdout];
if (new Set(allIds).size !== allIds.length) failures.push("split membership is not disjoint");
if ([...bySplit.train].some((id) => bySplit.holdout.has(id) || bySplit.dev.has(id))) failures.push("holdout id reachable from train/dev pool");
if ([...bySplit.dev].some((id) => bySplit.holdout.has(id))) failures.push("holdout id reachable from dev pool");

try {
  taskPool({ split: "holdout" });
  failures.push("holdout read succeeded without a frozen hash");
} catch {
  // Expected refusal.
}
try {
  taskPool({ split: "holdout", frozenHoldoutSha256: "not-the-frozen-hash" });
  failures.push("holdout read succeeded with an incorrect frozen hash");
} catch {
  // Expected refusal.
}

for (const task of TASKS) {
  if (deterministicTaskHash(task) !== deterministicTaskHash(task)) failures.push(`non-deterministic task: ${task.taskId}`);
}

const manifest = splitManifest();
const report = {
  fixture: manifest,
  counts: splitCounts(),
  totals: { tasks: TASKS.length },
  gates: {
    oracle_mean: oracleScores.reduce((sum, score) => sum + score, 0) / oracleScores.length,
    sentinel_max: Math.max(...sentinelScores),
    oracle_forbidden_effects: 0,
    failures,
  },
  fixture_sha256: fixtureSha256(),
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`WL-07 tasks: ${TASKS.length} (train ${report.counts.train} / dev ${report.counts.dev} / holdout ${report.counts.holdout})`);
  console.log(`fixture_sha256 : ${report.fixture.fixture_sha256}`);
  console.log(`train_sha256   : ${report.fixture.train_sha256}`);
  console.log(`dev_sha256     : ${report.fixture.dev_sha256}`);
  console.log(`holdout_sha256 : ${report.fixture.holdout_sha256}`);
  console.log(`splits_sha256  : ${report.fixture.splits_sha256}`);
  console.log(`oracle mean    : ${report.gates.oracle_mean.toFixed(4)}   sentinel max: ${report.gates.sentinel_max}`);
}

if (failures.length > 0) {
  console.error(`\nGATE FAILURES (${failures.length}):`);
  for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
  process.exit(1);
}
