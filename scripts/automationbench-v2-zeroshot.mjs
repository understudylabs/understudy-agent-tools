#!/usr/bin/env node
/**
 * Zero-shot difficulty probe for the AutomationBench v2 offline fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { V2_TASKS, v2SplitSha256, v2TaskPool } from "../dist/automationbench-v2.js";
import { createEpisodeRunner, summarizeRows } from "./automationbench-v2-episode.mjs";

// Kept as a source-level contract for rollout-mining consumers; the executable
// runner imports and uses the same prompt from automationbench-v2-episode.mjs.
const SYSTEM = [
  "You operate business apps through two tools.",
  'api_search — read-only endpoint discovery. arguments: {"query": string}',
  'api_fetch  — apply ONE API call. arguments: {"method": string, "url": string, "body": object}',
  "",
  "Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no second object:",
  '  {"tool": "api_search", "arguments": {"query": "..."}}',
  '  {"tool": "api_fetch", "arguments": {"method": "GET", "url": "/crm/contacts"}}',
  '  {"tool": "finish", "arguments": {}}   <- when the requested change is complete',
  "",
  "Read before you write: list the relevant collections first, then make the smallest set of writes that satisfies the request.",
  "Writing to a record the request did not ask you to change scores zero for the whole task.",
].join("\n");

void SYSTEM;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const model = argValue("--model");
if (!model) throw new Error("--model is required");
const split = argValue("--split", "dev");
const limit = Number(argValue("--limit", "0")) || 0;
const stride = Number(argValue("--stride", "1")) || 1;
const concurrency = Number(argValue("--concurrency", "6"));
const maxTurns = Number(argValue("--max-turns", "14"));
const temperature = Number(argValue("--temperature", "0"));
const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
const maxTokens = Number(argValue("--max-tokens", "512"));
const captureMalformed = Number(argValue("--capture-malformed", "0"));
const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
const outPath = argValue("--out");
const frozenHoldout = argValue("--frozen-holdout");

const pool = v2TaskPool({ split, frozenHoldoutSha256: frozenHoldout ?? undefined });
const strided = pool.filter((_task, index) => index % stride === 0);
const tasks = limit > 0 ? strided.slice(0, limit) : strided;
const runTask = createEpisodeRunner({
  model,
  baseUrl,
  temperature,
  maxTokens,
  maxTurns,
  malformedTolerance,
  captureMalformed,
});

const started = Date.now();
const rows = [];
let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
  while (cursor < tasks.length) {
    const task = tasks[cursor++];
    rows.push(await runTask(task));
    process.stderr.write(`\r${rows.length}/${tasks.length} done`);
  }
});
await Promise.all(workers);
process.stderr.write("\n");

const report = summarizeRows({
  model,
  split,
  poolSize: V2_TASKS.filter((task) => task.split === split).length,
  concurrency,
  rows,
  started,
});
report.split_sha256 = v2SplitSha256(split);
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
const { rows: _rows, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
