import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const artifactRoot = resolve(root, "experiments/nemotron-generalization-transfer/artifacts");
const groups = ["automationbench-simple-api", "event-categorizer", "synthetic-workflow-shapes"];
const parseArgs = () => {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
    args[token.slice(2).replaceAll("-", "_")] = process.argv[index + 1] ?? true;
    if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) index += 1;
  }
  return args;
};
const args = parseArgs();
const outRoot = resolve(root, String(args.artifacts ?? artifactRoot));
const splits = String(args.splits ?? "train,dev").split(",").map((split) => split.trim()).filter(Boolean);
if (splits.some((split) => !["train", "dev", "holdout"].includes(split))) {
  throw new Error("--splits must be a comma-separated list of train,dev,holdout");
}
const failures = [];
const checks = [];
for (const group of groups) {
  for (const split of splits) {
    const paths = {
      base: resolve(outRoot, `base-${group}-${split}.prompt-parity.json`),
      tuned: resolve(outRoot, `tuned-${group}-${split}.prompt-parity.json`),
    };
    const check = { group, split, files: paths, passed: false };
    if (!existsSync(paths.base) || !existsSync(paths.tuned)) {
      failures.push(`${group}/${split}: missing base or tuned parity file`);
      checks.push(check);
      continue;
    }
    const base = JSON.parse(readFileSync(paths.base, "utf8"));
    const tuned = JSON.parse(readFileSync(paths.tuned, "utf8"));
    const baseTasks = JSON.stringify(base.tasks);
    const tunedTasks = JSON.stringify(tuned.tasks);
    check.base_task_count = base.tasks?.length ?? 0;
    check.tuned_task_count = tuned.tasks?.length ?? 0;
    check.byte_identical = baseTasks === tunedTasks;
    check.passed = base.group === group && tuned.group === group &&
      base.split === split && tuned.split === split &&
      base.arm === "base" && tuned.arm === "tuned" &&
      check.byte_identical;
    if (!check.passed) failures.push(`${group}/${split}: base/tuned prompt hashes differ or metadata is invalid`);
    checks.push(check);
  }
}
const result = {
  schema_version: "understudy.generalization_prompt_parity_check.v1",
  generated_at: new Date().toISOString(),
  checks,
  passed: failures.length === 0,
  failures,
};
const output = resolve(outRoot, "prompt-parity-check.json");
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, output }, null, 2));
if (!result.passed) process.exitCode = 1;
