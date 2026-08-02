#!/usr/bin/env node
/**
 * Fail-closed gate run for the WL-OR (synthetic workload "orchestrator") slice.
 *
 * Refuses rather than repairs on:
 *   1. oracle reward != 1.0, or any oracle forbidden write;
 *   2. activity-sentinel reward != 0.0 on any slice task;
 *   3. free credit — a task already satisfied at reset;
 *   4. label leakage — grader keys or assertion paths visible in observations,
 *      or an oracle write literal no read can reach;
 *   5. a holdout read without the frozen fixture hash;
 *   6. non-deterministic reset or a duplicate task id.
 *
 * Usage: node experiments/workload-orchestrator/slice-gates.mjs [--out path.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  auditObservationLeakage,
  assertionSatisfied,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
  step,
} from "../../dist/synthetic-workflow-offline.js";
import {
  FROZEN_HOLDOUT_SHA256,
  SLICE,
  SLICE_BANDS,
  SLICE_TASKS,
  sliceCounts,
  sliceSha256,
  sliceSplitSha256,
  slicePool,
} from "./slice.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const failures = [];
const fail = (gate, detail) => failures.push({ gate, detail });

// 1 + 2 — oracle and sentinel.
let oracleMin = 1;
let sentinelMax = 0;
for (const task of SLICE_TASKS) {
  const oracle = rollout(task.taskId, oraclePolicy(task.taskId));
  oracleMin = Math.min(oracleMin, oracle.reward);
  if (oracle.reward !== 1) fail("oracle", `${task.taskId} scored ${oracle.reward}`);
  if (oracle.forbiddenEffects.length > 0) fail("oracle", `${task.taskId} wrote outside allowedWrites`);

  const sentinel = rollout(task.taskId, sentinelPolicy());
  sentinelMax = Math.max(sentinelMax, sentinel.reward);
  if (sentinel.reward !== 0) fail("sentinel", `${task.taskId} scored ${sentinel.reward}`);
}

// 3 — no free credit.
for (const task of SLICE_TASKS) {
  if (task.assertions.length === 0) fail("free-credit", `${task.taskId} has no assertions`);
  if (task.assertions.every((assertion) => assertionSatisfied(task.initialState, assertion))) {
    fail("free-credit", `${task.taskId} is already satisfied at reset`);
  }
}

// 4 — observation leakage and oracle-literal reachability.
const collectStrings = (value, output = []) => {
  if (typeof value === "string" && value.length > 2) output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, output);
  return output;
};

for (const task of SLICE_TASKS) {
  const { handle, obs } = reset(task.taskId);
  for (const finding of auditObservationLeakage(obs, task)) fail("leakage", `${task.taskId}: ${finding}`);

  const visible = [obs.messages.map((message) => message.content).join("\n")];
  for (const action of task.oracle) {
    const method = String(action.arguments.method ?? "").toUpperCase();
    if (action.name === "api_search" || (action.name === "api_fetch" && method === "GET")) {
      visible.push(step(handle, action).obs.messages.at(-1)?.content ?? "");
      continue;
    }
    break;
  }
  const readable = visible.join("\n");
  const isVisible = (literal) =>
    readable.includes(literal) || readable.includes(JSON.stringify(literal).slice(1, -1));
  for (const action of task.oracle) {
    const method = String(action.arguments.method ?? "").toUpperCase();
    if (action.name !== "api_fetch" || method === "GET") continue;
    for (const literal of collectStrings(action.arguments.body)) {
      if (!isVisible(literal)) fail("reachability", `${task.taskId} cannot reach write literal ${literal}`);
    }
    const parts = String(action.arguments.url ?? "").split("/").filter((part) => part.length > 2);
    const resourceId = parts.length > 1 ? parts.at(-1) : undefined;
    if (resourceId && !isVisible(resourceId)) {
      fail("reachability", `${task.taskId} cannot reach write target ${resourceId}`);
    }
  }
}

// 5 — frozen-holdout refusal.
let holdoutRefused = false;
try {
  slicePool("holdout");
} catch (cause) {
  holdoutRefused = /frozen-holdout refusal/.test(String(cause?.message ?? cause));
}
if (!holdoutRefused) fail("frozen-holdout", "holdout pool loaded without the frozen hash");
const holdoutTasks = slicePool("holdout", FROZEN_HOLDOUT_SHA256);

// 6 — determinism and unique ids.
const ids = SLICE_TASKS.map((task) => task.taskId);
if (new Set(ids).size !== ids.length) fail("determinism", "duplicate task id in the slice");
for (const task of SLICE_TASKS) {
  if (JSON.stringify(reset(task.taskId)) !== JSON.stringify(reset(task.taskId))) {
    fail("determinism", `${task.taskId} reset is not byte-identical`);
  }
}

const bandHistogram = SLICE_TASKS.reduce(
  (counts, task) => ({ ...counts, [task.band]: (counts[task.band] ?? 0) + 1 }),
  {},
);

const report = {
  schema_version: "understudy.workload_slice_gates.v1",
  slice: SLICE,
  bands: SLICE_BANDS,
  band_histogram: bandHistogram,
  tasks: SLICE_TASKS.length,
  counts: sliceCounts(),
  slice_sha256: sliceSha256(),
  split_sha256: {
    train: sliceSplitSha256("train"),
    dev: sliceSplitSha256("dev"),
    holdout: sliceSplitSha256("holdout"),
  },
  fixture_frozen_holdout_sha256: FROZEN_HOLDOUT_SHA256,
  holdout_tasks: holdoutTasks.length,
  gates: {
    oracle_min_reward: oracleMin,
    sentinel_max_reward: sentinelMax,
    free_credit: failures.some((entry) => entry.gate === "free-credit") ? "fail" : "clean",
    leakage: failures.some((entry) => entry.gate === "leakage") ? "fail" : "clean",
    reachability: failures.some((entry) => entry.gate === "reachability") ? "fail" : "clean",
    frozen_holdout_refusal: holdoutRefused ? "enforced" : "missing",
    determinism: failures.some((entry) => entry.gate === "determinism") ? "fail" : "clean",
  },
  failures,
  verdict: failures.length === 0 ? "pass" : "fail",
};

const outPath = argValue("--out");
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);
