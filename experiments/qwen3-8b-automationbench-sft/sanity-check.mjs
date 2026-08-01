#!/usr/bin/env node

import {
  oraclePolicy,
  rollout,
  sentinelPolicy,
  TASKS,
} from "../../dist/automationbench-offline.js";

const tasks = TASKS.filter((task) => task.split === "train" || task.split === "dev");
const oracleRewards = tasks.map((task) => rollout(task.taskId, oraclePolicy(task.taskId)).reward);
const sentinelRewards = tasks.map((task) => rollout(task.taskId, sentinelPolicy()).reward);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const oracleMean = mean(oracleRewards);
const sentinelMean = mean(sentinelRewards);

console.log(`oracle mean reward: ${oracleMean.toFixed(4)} (${tasks.length} train+dev tasks)`);
console.log(`sentinel mean reward: ${sentinelMean.toFixed(4)} (${tasks.length} train+dev tasks)`);

if (oracleMean !== 1 || sentinelMean !== 0) {
  console.error("sanity check failed");
  process.exitCode = 1;
}
