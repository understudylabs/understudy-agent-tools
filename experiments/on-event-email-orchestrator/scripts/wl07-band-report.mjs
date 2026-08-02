#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { taskBand } from "../src/wl07-fixture.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const basePath = argValue("--base");
const candidatePath = argValue("--candidate");
if (!basePath) throw new Error("--base is required");
const outPath = argValue("--out");

function readRun(path) {
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(run.rows)) throw new Error(`${path} has no rows[]`);
  return run;
}

const mean = (values) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
function summarize(run) {
  const grouped = {};
  for (const row of run.rows) (grouped[row.band ?? taskBand({ taskId: row.task_id })] ??= []).push(row);
  const bands = Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([band, rows]) => {
    const scored = rows.filter((row) => typeof row.score === "number");
    return [band, {
      tasks: rows.length,
      scored: scored.length,
      mean_score: mean(scored.map((row) => row.score)),
      exact_1: scored.filter((row) => row.score === 1).length,
      zero: scored.filter((row) => row.score === 0).length,
      over_acting_episodes: rows.filter((row) => row.forbidden_effects > 0).length,
      forbidden_writes: rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
      malformed_episodes: rows.filter((row) => row.malformed > 0).length,
    }];
  }));
  const scored = run.rows.filter((row) => typeof row.score === "number");
  return {
    model: run.model,
    split: run.split,
    split_sha256: run.split_sha256,
    tasks: run.rows.length,
    mean_score: mean(scored.map((row) => row.score)),
    over_acting_episodes: run.rows.filter((row) => row.forbidden_effects > 0).length,
    forbidden_writes: run.rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    malformed_episodes: run.rows.filter((row) => row.malformed > 0).length,
    bands,
  };
}

const base = summarize(readRun(basePath));
const candidate = candidatePath ? summarize(readRun(candidatePath)) : null;
if (candidate && (base.split !== candidate.split || base.split_sha256 !== candidate.split_sha256)) {
  throw new Error("split mismatch: both runs must score the same frozen split");
}
const delta = (a, b) => typeof a === "number" && typeof b === "number" ? b - a : null;
const report = {
  schema_version: "understudy.wl07_email_orchestration_band_report.v1",
  split: base.split,
  split_sha256: base.split_sha256,
  base,
  candidate,
  per_band_delta: candidate ? Object.fromEntries(Object.keys(base.bands).map((band) => [band, {
    tasks: base.bands[band].tasks,
    base_mean: base.bands[band].mean_score,
    candidate_mean: candidate.bands[band]?.mean_score ?? null,
    delta_mean: delta(base.bands[band].mean_score, candidate.bands[band]?.mean_score),
    base_over_acting_episodes: base.bands[band].over_acting_episodes,
    candidate_over_acting_episodes: candidate.bands[band]?.over_acting_episodes ?? null,
  }])) : null,
};
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
