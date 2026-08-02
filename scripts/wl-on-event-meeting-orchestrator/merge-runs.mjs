#!/usr/bin/env node
/**
 * Merge resumable workload runner artifacts without crossing fixture boundaries.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const inputs = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--run") continue;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--run requires a value");
  inputs.push(value);
}
const outPath = argValue("--out");
if (inputs.length === 0) throw new Error("at least one --run is required");
if (!outPath) throw new Error("--out is required");

const reports = inputs.map((path) => ({ path, report: JSON.parse(readFileSync(path, "utf8")) }));
const first = reports[0].report;
for (const { path, report } of reports) {
  for (const key of ["fixture_id", "split", "split_sha256", "model", "seed", "samples"]) {
    if (report[key] !== first[key]) {
      throw new Error(`${path} disagrees on ${key}: ${report[key]} != ${first[key]}`);
    }
  }
  if (!Array.isArray(report.rows)) throw new Error(`${path} has no rows[]`);
}

const rows = reports.flatMap(({ report }) => report.rows);
const seen = new Set();
for (const row of rows) {
  const key = `${row.task_id}:${row.sample_index}`;
  if (seen.has(key)) throw new Error(`duplicate task/sample row: ${key}`);
  seen.add(key);
}
const scored = rows.filter((row) => typeof row.score === "number");
const mean = (values) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const grouped = (key) => {
  const groups = {};
  for (const row of scored) (groups[row[key]] ??= []).push(row.score);
  return Object.fromEntries(Object.entries(groups).map(([name, values]) => [name, mean(values)]));
};
const count = (predicate) => rows.filter(predicate).length;
const output = {
  ...first,
  generated_at: new Date().toISOString(),
  source_runs: inputs,
  sampled: rows.length,
  scored: scored.length,
  errors: rows.length - scored.length,
  mean_score: mean(scored.map((row) => row.score)),
  exact_1_rate: scored.length === 0 ? null : count((row) => row.score === 1) / scored.length,
  zero_rate: scored.length === 0 ? null : count((row) => row.score === 0) / scored.length,
  mean_by_family: grouped("family"),
  mean_by_band: grouped("band"),
  over_acting_episodes: count((row) => row.over_acting),
  forbidden_writes: count((row) => row.forbidden_effects > 0),
  forbidden_effect_rate: rows.length === 0 ? null : count((row) => row.forbidden_effects > 0) / rows.length,
  malformed_rate: rows.length === 0 ? null : rows.reduce((sum, row) => sum + (row.malformed ?? 0), 0) / rows.length,
  prompt_tokens: rows.reduce((sum, row) => sum + (row.prompt_tokens ?? 0), 0),
  completion_tokens: rows.reduce((sum, row) => sum + (row.completion_tokens ?? 0), 0),
  rows,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  fixture_id: output.fixture_id,
  split: output.split,
  split_sha256: output.split_sha256,
  source_runs: inputs,
  sampled: output.sampled,
  scored: output.scored,
  mean_score: output.mean_score,
  out: outPath,
}, null, 2));
