#!/usr/bin/env node
/**
 * Build a train-only failure imitation set from the v2 offline fixture.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import {
  finish,
  oraclePolicy,
  reset,
  step,
} from "../dist/automationbench-offline.js";
import {
  V2_TASKS,
  v2FixtureSha256,
  v2SplitSha256,
  v2TaskBands,
  v2TaskPool,
} from "../dist/automationbench-v2.js";
import {
  createEpisodeRunner,
  SYSTEM,
  summarizeRows,
} from "./automationbench-v2-episode.mjs";

const MODEL_ID = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16";
const V1_HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701";
const V2_HOLDOUT_SHA256 = "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ensureTrainOnly(tasks) {
  if (tasks.length !== 120 || tasks.some((task) => task.split !== "train")) {
    throw new Error(`train-only assertion failed: expected 120 train tasks, got ${tasks.length}`);
  }
  const forbidden = new Set(
    V2_TASKS.filter((task) => task.split !== "train").map((task) => task.taskId),
  );
  if (tasks.some((task) => forbidden.has(task.taskId))) {
    throw new Error("train-only assertion failed: non-train task selected");
  }
}

function jsonTool(call) {
  return JSON.stringify({ tool: call.name, arguments: call.arguments });
}

function targetContent(call, policy) {
  if (policy !== "empty" && policy !== "preserve") {
    throw new Error("--think-block-policy must be empty or preserve");
  }
  const thinking = policy === "preserve" && call.thinking ? call.thinking : "";
  return `<think>\n${thinking}</think>\n${jsonTool(call)}`;
}

function goldMessages(task, thinkPolicy) {
  const { handle, obs: initial } = reset(task.taskId);
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task.prompt },
  ];
  const policy = oraclePolicy(task.taskId);
  let obs = initial;
  for (let turn = 0; turn < (task.maxSteps ?? 12); turn += 1) {
    const action = policy(obs);
    if (!action) break;
    messages.push({ role: "assistant", content: targetContent(action, thinkPolicy) });
    const result = step(handle, action);
    messages.push({ role: "user", content: result.obs.messages.at(-1).content.slice(0, 4000) });
    obs = result.obs;
    if (result.done) break;
  }
  messages.push({
    role: "assistant",
    content: targetContent({ name: "finish", arguments: {} }, thinkPolicy),
  });
  const terminal = finish(handle);
  if (!terminal.done) {
    throw new Error(`oracle finish did not terminate ${task.taskId}`);
  }
  if (terminal.reward !== 1 || handle.forbiddenEffects.length > 0) {
    throw new Error(`oracle trajectory failed for ${task.taskId}`);
  }
  return messages;
}

function failure(row) {
  return (
    (typeof row.score === "number" && row.score < 1) ||
    row.malformed > 0 ||
    row.forbidden_effects > 0 ||
    row.ended !== "finish"
  );
}

async function probe() {
  const baseUrl = argValue("--base-url", "https://api.fireworks.ai/inference/v1");
  const model = argValue("--model", MODEL_ID);
  const outPath = argValue("--probe-out", "outputs/base-nemotron3-nano-train-probe.json");
  const concurrency = Number(argValue("--concurrency", "6"));
  const maxTurns = Number(argValue("--max-turns", "14"));
  const temperature = Number(argValue("--temperature", "0"));
  const malformedTolerance = Number(argValue("--malformed-tolerance", "3"));
  const maxTokens = Number(argValue("--max-tokens", "512"));
  const tasks = v2TaskPool({ split: "train" });
  ensureTrainOnly(tasks);
  const runTask = createEpisodeRunner({
    model,
    baseUrl,
    temperature,
    maxTokens,
    maxTurns,
    malformedTolerance,
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
    split: "train",
    poolSize: tasks.length,
    rows,
    started,
    concurrency,
  });
  report.split_sha256 = v2SplitSha256("train");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
}

function build() {
  const probePath = argValue("--probe-report", "outputs/base-nemotron3-nano-train-probe.json");
  const outPath = argValue("--out", "outputs/sft-toolfail-selfgen.jsonl");
  const manifestPath = argValue("--manifest", `${outPath}.manifest.json`);
  const thinkPolicy = argValue("--think-block-policy", "empty");
  const probeBytes = readFileSync(probePath);
  const probe = JSON.parse(probeBytes);
  if (probe.split !== "train" || probe.split_sha256 !== v2SplitSha256("train")) {
    throw new Error("probe report is not the frozen v2 train split");
  }
  if (probe.sampled !== 120 || !Array.isArray(probe.rows) || probe.rows.length !== 120) {
    throw new Error("probe report must contain exactly 120 train rows");
  }
  const trainTasks = v2TaskPool({ split: "train" });
  ensureTrainOnly(trainTasks);
  const taskById = new Map(trainTasks.map((task) => [task.taskId, task]));
  const selected = probe.rows.filter(failure);
  if (selected.length === 0) throw new Error("failure selection is empty");
  if (selected.some((row) => !taskById.has(row.task_id))) {
    throw new Error("probe selected a task outside the v2 train split");
  }
  const bands = v2TaskBands();
  const byBand = {};
  const byFamily = {};
  const output = [];
  for (const row of selected) {
    const task = taskById.get(row.task_id);
    const family = row.family;
    const band = bands[family] ?? row.band;
    byBand[band] = (byBand[band] ?? 0) + 1;
    byFamily[family] = (byFamily[family] ?? 0) + 1;
    output.push(JSON.stringify({
      id: `toolfail-${task.taskId}`,
      task_id: task.taskId,
      messages: goldMessages(task, thinkPolicy),
    }));
  }
  const corpus = `${output.join("\n")}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, corpus);
  const manifest = {
    fixture: "automationbench-simple-api-offline-v2",
    fixture_sha256: v2FixtureSha256(),
    corpus_sha256: sha256(corpus),
    probe_report_sha256: sha256(probeBytes),
    probe_report: probePath,
    rows: output.length,
    examples: output.reduce((sum, line) => sum + JSON.parse(line).messages.filter((message) => message.role === "assistant").length, 0),
    selection_rule: 'score < 1 OR malformed > 0 OR forbidden_effects > 0 OR ended != "finish"',
    selected_failure_counts_by_band: Object.fromEntries(Object.entries(byBand).sort()),
    selected_failure_counts_by_family: Object.fromEntries(Object.entries(byFamily).sort()),
    think_block_policy: thinkPolicy,
    split_hashes: {
      v2_train: v2SplitSha256("train"),
      v2_dev: v2SplitSha256("dev"),
      v2_holdout: V2_HOLDOUT_SHA256,
      v1_holdout: V1_HOLDOUT_SHA256,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

if (hasFlag("--probe") === hasFlag("--build")) {
  throw new Error("select exactly one of --probe or --build");
}
if (hasFlag("--probe")) await probe();
if (hasFlag("--build")) build();
