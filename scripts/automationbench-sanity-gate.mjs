#!/usr/bin/env node
import {
  getTask,
  rollout,
  sentinelPolicy,
  oraclePolicy,
  taskBands,
} from "../dist/automationbench-offline.js";

const requested = [
  "simple-api-crm-close-01",
  "simple-api-crm-bulk-owner-01",
];

const results = requested.map((taskId) => {
  const task = getTask(taskId);
  const oracle = rollout(taskId, oraclePolicy(taskId));
  const sentinel = rollout(taskId, sentinelPolicy());
  return {
    task_id: taskId,
    split: task.split,
    band: taskBands()[taskId.slice("simple-api-".length, -3)],
    oracle: oracle.reward,
    sentinel: sentinel.reward,
    oracle_steps: oracle.steps,
    sentinel_steps: sentinel.steps,
    sentinel_forbidden_effects: sentinel.forbiddenEffects,
  };
});

if (results.some((result) => result.split !== "train")) {
  throw new Error("sanity gate tasks must be train tasks");
}
if (results.some((result) => result.oracle !== 1 || result.sentinel !== 0)) {
  throw new Error(`sanity gate failed: ${JSON.stringify(results)}`);
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
