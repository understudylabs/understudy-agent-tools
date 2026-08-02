#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { replayOracleTrajectory } from "../dist/automationbench-rl-service.js";
import { taskPool } from "../dist/automationbench-offline.js";

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function usage() {
  return `Usage: node scripts/automationbench-oracle-trajectories.mjs --out <path>`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(usage());
    return;
  }
  const outPath = argValue(args, "--out");
  if (!outPath) throw new Error("--out is required");
  const resolvedOutPath = resolve(outPath);
  mkdirSync(dirname(resolvedOutPath), { recursive: true });
  const lines = [];
  for (const task of taskPool({ split: "train" })) {
    const trajectory = replayOracleTrajectory(task.taskId);
    if (trajectory.reward !== 1) {
      throw new Error(`oracle trajectory for ${task.taskId} scored ${trajectory.reward}`);
    }
    lines.push(
      JSON.stringify({
        task_id: trajectory.task_id,
        split: trajectory.split,
        family: trajectory.family,
        band: trajectory.band,
        reward: trajectory.reward,
        messages: trajectory.messages,
      }),
    );
  }
  writeFileSync(resolvedOutPath, `${lines.join("\n")}\n`);
  console.log(JSON.stringify({ out: resolvedOutPath, rows: lines.length, reward: 1 }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
