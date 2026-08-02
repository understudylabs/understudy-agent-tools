#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  finish,
  getTask,
  oraclePolicy,
  partialCredit,
  reset,
  step,
  taskBandForId,
  taskPool,
} from "../dist/automationbench-offline.js";

const SYSTEM_PROMPT = `You operate business apps by calling tools. Reply with exactly ONE JSON object and nothing else.

Allowed replies:
{"tool":"api_search","arguments":{"query":"<text>"}}
{"tool":"api_fetch","arguments":{"method":"GET|POST|PATCH","url":"<path>","body":{...}}}
{"tool":"finish","arguments":{}}

api_search is read-only endpoint discovery. api_fetch applies one API call and is the only way to change state. Endpoints: /crm/contacts (GET), /crm/contacts/{id} (GET, PATCH), /mail/drafts (GET, POST), /mail/drafts/{id} (GET, PATCH), /mail/messages (GET, POST with {"draft_id":"..."}).

Each tool result is returned to you as JSON. Look up any id you need before writing. Make the smallest change that satisfies the request, touch nothing else, then reply with the finish action.`;

function replayOracleTrajectory(taskId) {
  const task = getTask(taskId);
  const { handle } = reset(taskId);
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task.prompt },
  ];
  const policy = oraclePolicy(taskId);
  while (true) {
    const action = policy({ step: handle.step });
    if (!action) break;
    messages.push({ role: "assistant", content: JSON.stringify({ tool: action.name, arguments: action.arguments }) });
    const result = step(handle, action);
    messages.push({ role: "tool", content: JSON.stringify(result.obs.messages.at(-1)) });
    if (result.done) break;
  }
  const terminal = handle.done ? { reward: partialCredit(handle) } : finish(handle);
  messages.push({ role: "assistant", content: JSON.stringify({ tool: "finish", arguments: {} }) });
  return {
    task_id: task.taskId,
    split: task.split,
    family: task.taskId.split("-").slice(2, -1).join("-"),
    band: taskBandForId(task.taskId),
    reward: terminal.reward,
    messages,
  };
}

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
