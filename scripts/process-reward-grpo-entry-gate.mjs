#!/usr/bin/env node

import { startEnvService } from "../dist/automationbench-rl-service.js";
import { v2SplitSha256, v2TaskPool } from "../dist/automationbench-v2.js";

const HOLDOUT_SHA256 = "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9";
const sanityTasks = [
  v2TaskPool({ split: "train" }).find((task) => task.taskId === "simple-api-crm-close-01"),
  v2TaskPool({ split: "train" }).find((task) => task.taskId === "hard-api-churn-cascade-01"),
].filter(Boolean);

async function request(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path} failed: ${JSON.stringify(value)}`);
  return value;
}

async function score(task, oracle) {
  const reset = await request(globalThis.port, "/reset", { task_id: task.taskId });
  if (oracle) {
    for (const action of task.oracle) {
      await request(globalThis.port, "/step", {
        episode_id: reset.episode_id,
        action,
      });
    }
  }
  return await request(globalThis.port, "/finish", {
    episode_id: reset.episode_id,
    explicit_finished: oracle,
    truncated: !oracle,
  });
}

const { server, port } = await startEnvService({
  benchmark: "automationbench-v2",
  port: 0,
});
globalThis.port = port;
try {
  const checks = [];
  for (const task of sanityTasks) {
    const oracle = await score(task, true);
    checks.push({
      id: `oracle:${task.taskId}`,
      status: oracle.reward === 1 ? "pass" : "fail",
      detail: `oracle terminal reward = ${oracle.reward}; expected exactly 1.0`,
    });
    const sentinel = await score(task, false);
    checks.push({
      id: `sentinel:${task.taskId}`,
      status: sentinel.reward === 0 ? "pass" : "fail",
      detail: `sentinel terminal reward = ${sentinel.reward}; expected exactly 0.0`,
    });
  }

  for (const [label, hash] of [
    ["no-hash", undefined],
    ["wrong-hash", "0".repeat(64)],
    ["exact-hash", HOLDOUT_SHA256],
  ]) {
    let status = "fail";
    try {
      const url = new URL(`http://127.0.0.1:${port}/tasks?split=holdout`);
      if (hash !== undefined) url.searchParams.set("frozen_holdout_sha256", hash);
      const response = await fetch(url);
      status = label === "exact-hash" ? (response.ok ? "pass" : "fail") : (!response.ok ? "pass" : "fail");
    } catch {
      status = label === "exact-hash" ? "fail" : "pass";
    }
    checks.push({
      id: `holdout:${label}`,
      status,
      detail: `holdout ${label} gate`,
    });
  }

  const result = {
    schema_version: "understudy.process_reward_grpo_entry_gate.v1",
    fixture: "automationbench-simple-api-offline-v2",
    holdout_sha256: v2SplitSha256("holdout"),
    expected_holdout_sha256: HOLDOUT_SHA256,
    sanity_task_ids: sanityTasks.map((task) => task.taskId),
    checks,
    passed: checks.every((check) => check.status === "pass"),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  server.close();
}
