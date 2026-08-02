#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  fixtureSha256,
  oraclePolicy,
  rollout,
  sentinelPolicy,
  splitSha256,
  taskBand,
  taskPool,
} from "../dist/automationbench-offline.js";

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const outPath = argValue(args, "--out");
  if (!outPath) throw new Error("--out is required");
  const train = taskPool({ split: "train" });
  const selected = ["single-write", "multi-write"].map((requiredBand) => {
    const task = train.find((candidate) => taskBand(candidate.taskId) === requiredBand);
    if (!task) throw new Error(`no train task found for ${requiredBand}`);
    return { task, requiredBand };
  });
  const rows = selected.map(({ task, requiredBand }) => {
    const band = taskBand(task.taskId);
    if (band !== requiredBand) throw new Error(`task metadata band mismatch for ${task.taskId}`);
    const oracle = rollout(task.taskId, oraclePolicy(task.taskId));
    const sentinel = rollout(task.taskId, sentinelPolicy());
    if (oracle.reward !== 1) {
      throw new Error(`oracle sanity failure for ${task.taskId}: ${oracle.reward}`);
    }
    if (sentinel.reward !== 0) {
      throw new Error(`sentinel sanity failure for ${task.taskId}: ${sentinel.reward}`);
    }
    return {
      task_id: task.taskId,
      split: task.split,
      band,
      oracle_reward: oracle.reward,
      sentinel_reward: sentinel.reward,
    };
  });
  const result = {
    fixture_sha256: fixtureSha256(),
    split_sha256: {
      train: splitSha256("train"),
      dev: splitSha256("dev"),
      holdout: splitSha256("holdout"),
    },
    rows,
    passed: true,
  };
  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
