#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import {
  ACTION_PROTOCOL_SYSTEM_PROMPT,
} from "../../dist/automationbench-action-protocol.js";
import {
  finish,
  oraclePolicy,
  reset,
  step,
} from "../../dist/automationbench-offline.js";
import { v2TaskBands, v2TaskPool } from "../../dist/automationbench-v2.js";

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "train" },
    out: { type: "string" },
    "task-ids": { type: "string" },
    "only-failed": { type: "string" },
    "frozen-holdout": { type: "string" },
  },
});

if (!values.out) throw new Error("--out is required");
if (!["train", "dev", "holdout"].includes(values.split)) throw new Error("--split must be train, dev, or holdout");
if (values.split === "holdout" && !values["frozen-holdout"]) {
  throw new Error("holdout export requires --frozen-holdout");
}

const failedIds = values["only-failed"]
  ? new Set(
      JSON.parse(readFileSync(values["only-failed"], "utf8")).rows
        .filter((row) => row.score !== 1)
        .map((row) => row.task_id),
    )
  : null;
const requestedIds = values["task-ids"] ? new Set(values["task-ids"].split(",").filter(Boolean)) : null;
const pool = v2TaskPool({
  split: values.split,
  frozenHoldoutSha256: values["frozen-holdout"],
});
const bands = v2TaskBands();
const tasks = pool.filter((task) => (!requestedIds || requestedIds.has(task.taskId)) && (!failedIds || failedIds.has(task.taskId)));
if (requestedIds && tasks.length !== requestedIds.size) throw new Error("one or more --task-ids are not in the selected split");

function family(taskId) {
  return taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

const rows = [];
for (const task of tasks) {
  const { handle, obs: initial } = reset(task.taskId);
  const messages = [
    { role: "system", content: ACTION_PROTOCOL_SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];
  let obs = initial;
  const policy = oraclePolicy(task.taskId);
  for (let i = 0; i < task.oracle.length; i += 1) {
    const action = policy(obs);
    if (!action) throw new Error(`oracle stopped early for ${task.taskId}`);
    messages.push({ role: "assistant", content: JSON.stringify({ tool: action.name, arguments: action.arguments }) });
    const result = step(handle, action);
    obs = result.obs;
    const observation = obs.messages.at(-1)?.content;
    if (typeof observation !== "string") throw new Error(`oracle observation missing for ${task.taskId}`);
    messages.push({ role: "user", content: observation });
  }
  const finishAction = policy(obs);
  if (finishAction) throw new Error(`oracle emitted an unexpected extra action for ${task.taskId}`);
  messages.push({ role: "assistant", content: JSON.stringify({ tool: "finish", arguments: {} }) });
  const terminal = finish(handle);
  if (terminal.reward !== 1) throw new Error(`oracle scored ${terminal.reward} on ${task.taskId}`);
  rows.push({
    task_id: task.taskId,
    band: bands[family(task.taskId)] ?? "unknown",
    split: task.split,
    messages,
  });
}

writeFileSync(values.out, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
const bytes = readFileSync(values.out);
writeFileSync(`${values.out}.manifest.json`, `${JSON.stringify({
  schema_version: "understudy.artifact-manifest.v1",
  artifacts: [{
    role: "oracle_jsonl",
    path: values.out,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: statSync(values.out).size,
    row_count: rows.length,
  }],
}, null, 2)}\n`);
console.log(JSON.stringify({ rows: rows.length, split: values.split, out: values.out }));
