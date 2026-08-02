import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as automation from "../dist/automationbench-offline.js";
import * as events from "../dist/event-categorizer-offline.js";
import * as synthetic from "../dist/synthetic-workflow-offline.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "experiments/nemotron-generalization-transfer/artifacts/sanity-gate.json");

const automationFamily = (task) => task.taskId.replace(/^simple-api-/, "").replace(/-\d+$/, "");
const automationBands = automation.taskBands();
const policyCheck = (module, taskId, band, family = undefined) => {
  const oracle = module.rollout(taskId, module.oraclePolicy(taskId));
  const sentinel = module.rollout(taskId, module.sentinelPolicy());
  return {
    group: family ? "A" : "C",
    task_id: taskId,
    band,
    oracle_reward: oracle.reward,
    sentinel_reward: sentinel.reward,
    oracle_forbidden_effects: oracle.forbiddenEffects,
    sentinel_forbidden_effects: sentinel.forbiddenEffects,
    passed: oracle.reward === 1 && sentinel.reward === 0,
  };
};

const aSingle = automation.TASKS.find((task) => automationBands[automationFamily(task)] === "single-write");
const aMulti = automation.TASKS.find((task) => automationBands[automationFamily(task)] === "multi-write");
const cSingle = synthetic.TASKS.find((task) => task.band === "single-write");
const cMulti = synthetic.TASKS.find((task) => task.band === "multi-write");
const checks = [
  policyCheck(automation, aSingle.taskId, "single-write", automationFamily(aSingle)),
  policyCheck(automation, aMulti.taskId, "multi-write", automationFamily(aMulti)),
  policyCheck(synthetic, cSingle.taskId, "single-write"),
  policyCheck(synthetic, cMulti.taskId, "multi-write"),
];

const eventTask = events.TASKS[0];
const eventGold = events.scoreCompletion(eventTask.task_id, JSON.stringify(eventTask.gold));
const eventEmpty = events.scoreCompletion(eventTask.task_id, "");
checks.push({
  group: "B",
  variant: "gold-vs-empty-completion",
  task_id: eventTask.task_id,
  gold_score: eventGold.score,
  empty_score: eventEmpty.score,
  passed: eventGold.score === 1 && eventEmpty.score === 0,
});

const artifact = {
  schema_version: "understudy.generalization_sanity_gate.v1",
  generated_at: new Date().toISOString(),
  checks,
  passed: checks.every((check) => check.passed),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ output, passed: artifact.passed }, null, 2));
if (!artifact.passed) process.exitCode = 1;
