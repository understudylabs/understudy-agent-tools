#!/usr/bin/env node
/**
 * Gate receipt for the `domain-identification` synthetic slice.
 *
 * `tests/domain-identification-slice.test.mjs` is what enforces these gates in
 * CI; this emits the same checks as a signed-by-hashes JSON receipt so a run's
 * results can be read next to the fixture state they were produced against.
 * Any failed gate exits non-zero — a slice that does not gate cannot be scored.
 *
 *   node experiments/domain-identification-repair/gate-check.mjs \
 *     --out experiments/domain-identification-repair/outputs/gate-validation.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  assertionSatisfied,
  auditObservationLeakage,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
} from "../../dist/automationbench-offline.js";
import {
  DOMAIN_ID_TASKS,
  domainIdFixtureSha256,
  domainIdSplitCounts,
  domainIdSplitManifest,
  domainIdSplitSha256,
  domainIdTaskPool,
} from "../../dist/domain-identification-slice.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const gates = [];
const record = (gate, pass, detail) => gates.push({ gate, pass, detail });

const oracle = DOMAIN_ID_TASKS.map((task) => rollout(task.taskId, oraclePolicy(task.taskId)));
record(
  "oracle scores 1.0 on every task",
  oracle.every((run) => run.reward === 1),
  `${oracle.filter((run) => run.reward === 1).length}/${oracle.length} at reward 1.0`,
);
record(
  "oracle triggers no forbidden write",
  oracle.every((run) => run.forbiddenEffects.length === 0),
  `${oracle.reduce((sum, run) => sum + run.forbiddenEffects.length, 0)} forbidden writes`,
);

const sentinel = DOMAIN_ID_TASKS.map((task) => rollout(task.taskId, sentinelPolicy()));
record(
  "reward-hacking sentinel scores 0.0 on every task",
  sentinel.every((run) => run.reward === 0),
  `max sentinel reward ${Math.max(...sentinel.map((run) => run.reward))}`,
);

const leakage = DOMAIN_ID_TASKS.flatMap((task) => auditObservationLeakage(reset(task.taskId).obs, task));
record("no grader key or assertion path leaks into an observation", leakage.length === 0, `${leakage.length} findings`);

const promptLeaks = DOMAIN_ID_TASKS.filter((task) =>
  task.assertions.some((assertion) => assertion.kind === "equals" && task.prompt.includes(assertion.path)));
record("no prompt restates an assertion path", promptLeaks.length === 0, `${promptLeaks.length} tasks`);

const freeCredit = DOMAIN_ID_TASKS.filter((task) =>
  task.assertions.every((assertion) => assertionSatisfied(task.initialState, assertion)));
record("no task is already satisfied at reset", freeCredit.length === 0, `${freeCredit.length} pre-satisfied tasks`);

const refusals = [];
try {
  domainIdTaskPool({ split: "holdout" });
} catch (error) {
  refusals.push(String(error.message));
}
try {
  domainIdTaskPool({ split: "holdout", frozenHoldoutSha256: "not-the-hash" });
} catch (error) {
  refusals.push(String(error.message));
}
record(
  "frozen holdout refuses a missing or wrong hash",
  refusals.length === 2 && refusals.every((message) => message.includes("frozen-holdout refusal")),
  `${refusals.length}/2 refusals`,
);
record(
  "frozen holdout opens for the exact hash only",
  domainIdTaskPool({ split: "holdout", frozenHoldoutSha256: domainIdSplitSha256("holdout") }).length ===
    domainIdSplitCounts().holdout,
  `${domainIdSplitCounts().holdout} tasks`,
);

const deterministic = DOMAIN_ID_TASKS.every(
  (task) => JSON.stringify(reset(task.taskId).obs) === JSON.stringify(reset(task.taskId).obs),
);
record("reset is deterministic", deterministic, `${DOMAIN_ID_TASKS.length} tasks`);

const receipt = {
  schema_version: "understudy.slice_gate_validation.v1",
  fixture_id: "domain-identification-offline-v1",
  generated_at: new Date().toISOString(),
  fixture_sha256: domainIdFixtureSha256(),
  splits: domainIdSplitManifest(),
  gates,
  verdict: gates.every((gate) => gate.pass) ? "pass" : "fail",
};

const outPath = argValue("--out");
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
if (receipt.verdict !== "pass") process.exit(1);
