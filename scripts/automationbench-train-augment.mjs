import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAugmentedTrainSet } from "../dist/automationbench-train-augment.js";

const outputDir = resolve("experiments/automationbench-train-augment/v1");
const files = {
  tasks: join(outputDir, "tasks.jsonl"),
  trajectories: join(outputDir, "trajectories.jsonl"),
  manifest: join(outputDir, "manifest.json"),
  contamination: join(outputDir, "contamination-report.json"),
};

function render(set) {
  return {
    tasks: `${set.tasks.map((task) => JSON.stringify(task)).join("\n")}\n`,
    trajectories: `${set.trajectories.map((trajectory) => JSON.stringify(trajectory)).join("\n")}\n`,
    manifest: `${JSON.stringify(set.manifest, null, 2)}\n`,
    contamination: `${JSON.stringify(set.contamination, null, 2)}\n`,
  };
}

function check(rendered) {
  const drift = Object.entries(files)
    .filter(([key, path]) => !existsSync(path) || readFileSync(path, "utf8") !== rendered[key])
    .map(([key, path]) => `${key}: ${path}`);
  if (drift.length > 0) throw new Error(`automationbench train artifact drift:\n${drift.join("\n")}`);
}

const set = buildAugmentedTrainSet();
const rendered = render(set);
if (process.argv.includes("--check")) {
  check(rendered);
  console.log(`automationbench train artifacts match (${set.tasks.length} tasks, ${set.trajectories.length} trajectories)`);
} else {
  if (!existsSync(resolve("experiments/automationbench-train-augment"))) mkdirSync(resolve("experiments/automationbench-train-augment"));
  if (!existsSync(outputDir)) mkdirSync(outputDir);
  writeFileSync(files.tasks, rendered.tasks);
  writeFileSync(files.trajectories, rendered.trajectories);
  writeFileSync(files.manifest, rendered.manifest);
  writeFileSync(files.contamination, rendered.contamination);
  console.log(`wrote ${set.tasks.length} tasks and ${set.trajectories.length} trajectories to ${outputDir}`);
}
