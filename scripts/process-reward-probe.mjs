#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  V2_TASKS,
  v2TaskBands,
} from "../dist/automationbench-v2.js";
import {
  createProcessRewardEpisode,
  DEFAULT_PROCESS_REWARD_CONFIG,
} from "../dist/process-reward.js";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : "artifacts/process-reward-probe.json";
if (outIndex >= 0 && (!out || out.startsWith("--"))) throw new Error("--out requires a path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function checker(state, assertion) {
  if (assertion.kind === "equals") {
    return assertion.path.split(".").reduce((node, key) => node?.[key], state) === assertion.equals;
  }
  const collection = assertion.collection.split(".").reduce((node, key) => node?.[key], state);
  const entries = collection && typeof collection === "object" ? Object.values(collection) : [];
  const present = entries.some((entry) =>
    Object.entries(assertion.match).every(([key, value]) => JSON.stringify(entry?.[key]) === JSON.stringify(value)));
  return assertion.kind === "exists" ? present : !present;
}

function setPath(state, dotted, value) {
  const keys = dotted.split(".");
  let node = state;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = value;
}

function satisfy(state, assertion) {
  if (assertion.kind === "equals") {
    setPath(state, assertion.path, clone(assertion.equals));
    return;
  }
  const collection = assertion.collection.split(".");
  let node = state;
  for (const key of collection) node = node[key];
  if (assertion.kind === "exists") node[`probe-${Object.keys(node).length}`] = clone(assertion.match);
  if (assertion.kind === "absent") {
    for (const [key, value] of Object.entries(node)) {
      if (Object.entries(assertion.match).every(([field, expected]) => value?.[field] === expected)) delete node[key];
    }
  }
}

function runOracle(task) {
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  let before = clone(task.initialState);
  let environment = { forbiddenEffects: [] };
  const actions = task.oracle ?? [];
  for (let index = 0; index < actions.length; index += 1) {
    const after = clone(before);
    const assertion = task.assertions[index % Math.max(1, task.assertions.length)];
    satisfy(after, assertion);
    episode.step(before, actions[index], after, environment, environment, "");
    before = after;
  }
  return episode.finish({ finalState: before, terminal: 1, explicitlyFinished: true, truncated: false });
}

function runNoop(task) {
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  return episode.finish({
    finalState: clone(task.initialState),
    terminal: 0,
    explicitlyFinished: true,
    truncated: false,
  });
}

function runSpam(task) {
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  const state = clone(task.initialState);
  const environment = { forbiddenEffects: [] };
  for (let index = 0; index < 12; index += 1) {
    episode.step(
      state,
      { name: "api_search", arguments: { query: `probe-${index}` } },
      state,
      environment,
      environment,
      `{"results":[{"id":"probe-${index}"}]}`,
    );
  }
  return episode.finish({ finalState: state, terminal: 0, explicitlyFinished: false, truncated: true });
}

function runWriteEverything(task) {
  const episode = createProcessRewardEpisode({ task, assertionChecker: checker });
  const state = clone(task.initialState);
  let environment = { forbiddenEffects: [] };
  for (let index = 0; index < 8; index += 1) {
    const nextEnvironment = { forbiddenEffects: [...environment.forbiddenEffects, `guard-${index}`] };
    episode.step(
      state,
      { name: "api_fetch", arguments: { method: "PATCH", url: `/guard/${index}` } },
      state,
      environment,
      nextEnvironment,
    );
    environment = nextEnvironment;
  }
  return episode.finish({ finalState: state, terminal: 0, explicitlyFinished: true, truncated: false });
}

const bands = v2TaskBands();
function familyOf(task) {
  return String(task.taskId)
    .replace(/^(?:simple|hard)-api-/, "")
    .replace(/-\d+$/, "");
}
const grouped = new Map();
for (const task of V2_TASKS) {
  const band = task.band ?? bands[familyOf(task)] ?? "unknown";
  if (!grouped.has(band)) grouped.set(band, []);
  grouped.get(band).push({ ...task, band });
}

const perBand = {};
const invariants = [];
for (const [band, tasks] of grouped) {
  const rows = tasks.map((task) => {
    const oracle = runOracle(task);
    const noop = runNoop(task);
    const spam = runSpam(task);
    const writeEverything = runWriteEverything(task);
    return {
      oracle_raw: oracle.rawProcessTotal,
      oracle_clipped: oracle.processTotal,
      noop_raw: noop.rawProcessTotal,
      noop_clipped: noop.processTotal,
      spam_raw: spam.rawProcessTotal,
      spam_clipped: spam.processTotal,
      write_everything_raw: writeEverything.rawProcessTotal,
      write_everything_clipped: writeEverything.processTotal,
      oracle_combined: oracle.combined,
      noop_combined: noop.combined,
      spam_combined: spam.combined,
      write_everything_combined: writeEverything.combined,
      max_process: Math.max(oracle.processTotal, noop.processTotal, spam.processTotal, writeEverything.processTotal),
      oracle_clip_bound: Math.abs(oracle.rawProcessTotal) >= DEFAULT_PROCESS_REWARD_CONFIG.kappa,
    };
  });
  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  const entry = {
    task_count: rows.length,
    oracle_raw: mean("oracle_raw"),
    oracle_clipped: mean("oracle_clipped"),
    no_op_raw: mean("noop_raw"),
    no_op_clipped: mean("noop_clipped"),
    spam_raw: mean("spam_raw"),
    spam_clipped: mean("spam_clipped"),
    write_everything_raw: mean("write_everything_raw"),
    write_everything_clipped: mean("write_everything_clipped"),
    oracle_combined: mean("oracle_combined"),
    no_op_combined: mean("noop_combined"),
    spam_combined: mean("spam_combined"),
    write_everything_combined: mean("write_everything_combined"),
    max_achievable_process_reward: Math.max(...rows.map((row) => row.max_process)),
    clip_bound: rows.some((row) => row.oracle_clip_bound),
  };
  perBand[band] = entry;
  invariants.push({
    band,
    oracle_beats_noop: rows.every((row) => row.oracle_combined > row.noop_combined),
    spam_net_negative: rows.every((row) => row.spam_combined < 0),
    write_everything_worse_than_noop: rows.every((row) => row.write_everything_combined < row.noop_combined),
    clip_bound: rows.every((row) => !row.oracle_clip_bound),
  });
}

const report = {
  schema_version: "understudy.process_reward_probe.v1",
  fixture_id: "automationbench-simple-api-offline-v2",
  task_count: V2_TASKS.length,
  bands: perBand,
  invariants,
  verdict: invariants.every((row) => Object.values(row).slice(1).every(Boolean)) ? "PASS" : "FAIL",
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, verdict: report.verdict, bands: Object.keys(perBand) }, null, 2));
