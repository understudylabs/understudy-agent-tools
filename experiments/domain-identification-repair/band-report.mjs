#!/usr/bin/env node
/**
 * Base vs DPO lift table for the `domain-identification` slice.
 *
 * Takes two rollout reports emitted by `rollout.mjs` (same split, same sampling
 * path, different weights) and prints the paired comparison: per-band mean
 * outcome, exact-1.0 rate, and the two regression guards that must not move the
 * wrong way — over-acting episodes and forbidden writes.
 *
 * Paired, not pooled: both arms ran the same task ids, so per-task deltas are
 * the honest unit. Tasks missing from either arm are dropped rather than
 * imputed.
 *
 *   node experiments/domain-identification-repair/band-report.mjs \
 *     --base outputs/base-dev.json --candidate outputs/dpo-dev.json \
 *     --out outputs/lift-dev.json
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

const basePath = argValue("--base");
const candidatePath = argValue("--candidate");
if (!basePath || !candidatePath) throw new Error("--base and --candidate are required");
const outPath = argValue("--out");

const base = JSON.parse(readFileSync(basePath, "utf8"));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
if (base.split !== candidate.split) throw new Error(`split mismatch: ${base.split} vs ${candidate.split}`);
if (base.split_sha256 !== candidate.split_sha256) {
  throw new Error("split_sha256 mismatch: the two arms did not score the same frozen tasks");
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const round = (value) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value);

/** One score per task id (mean over samples), so an arm with more samples cannot outvote the other. */
function byTask(report) {
  const scores = new Map();
  for (const row of report.rows) {
    if (typeof row.score !== "number") continue;
    if (!scores.has(row.task_id)) scores.set(row.task_id, { band: row.band, values: [] });
    scores.get(row.task_id).values.push(row.score);
  }
  return scores;
}

const baseByTask = byTask(base);
const candidateByTask = byTask(candidate);
const shared = [...baseByTask.keys()].filter((taskId) => candidateByTask.has(taskId)).sort();

const bands = new Map();
for (const taskId of shared) {
  const band = baseByTask.get(taskId).band;
  if (!bands.has(band)) bands.set(band, { base: [], candidate: [] });
  bands.get(band).base.push(mean(baseByTask.get(taskId).values));
  bands.get(band).candidate.push(mean(candidateByTask.get(taskId).values));
}

const rows = [...bands.entries()]
  .map(([band, values]) => ({
    band,
    tasks: values.base.length,
    base: round(mean(values.base)),
    candidate: round(mean(values.candidate)),
    delta: round(mean(values.candidate) - mean(values.base)),
    improved: values.base.filter((score, index) => values.candidate[index] > score).length,
    regressed: values.base.filter((score, index) => values.candidate[index] < score).length,
  }))
  .sort((left, right) => left.band.localeCompare(right.band));

const overall = {
  tasks: shared.length,
  base: round(mean(shared.map((taskId) => mean(baseByTask.get(taskId).values)))),
  candidate: round(mean(shared.map((taskId) => mean(candidateByTask.get(taskId).values)))),
};
overall.delta = round(overall.candidate - overall.base);

const guards = {
  over_acting_episodes: { base: base.over_acting_episodes, candidate: candidate.over_acting_episodes },
  forbidden_writes: { base: base.forbidden_writes, candidate: candidate.forbidden_writes },
  malformed_rate: { base: round(base.malformed_rate), candidate: round(candidate.malformed_rate) },
  mean_completion_tokens: { base: round(base.mean_completion_tokens), candidate: round(candidate.mean_completion_tokens) },
  errors: { base: base.errors, candidate: candidate.errors },
};
guards.verdict =
  candidate.forbidden_writes > base.forbidden_writes || candidate.over_acting_episodes > base.over_acting_episodes
    ? "REGRESSION: the candidate over-acts more than the base"
    : "no over-acting regression";

const report = {
  schema_version: "understudy.slice_lift.v1",
  fixture: base.fixture,
  split: base.split,
  split_sha256: base.split_sha256,
  base_model: base.model,
  candidate_model: candidate.model,
  base_samples: base.samples,
  candidate_samples: candidate.samples,
  overall,
  by_band: rows,
  exact_1_rate: { base: round(base.exact_1_rate), candidate: round(candidate.exact_1_rate) },
  guards,
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
console.log("");
console.log(`| band | tasks | base | DPO | delta |`);
console.log(`| --- | ---: | ---: | ---: | ---: |`);
for (const row of rows) console.log(`| ${row.band} | ${row.tasks} | ${row.base} | ${row.candidate} | ${row.delta >= 0 ? "+" : ""}${row.delta} |`);
console.log(`| **overall** | ${overall.tasks} | ${overall.base} | ${overall.candidate} | ${overall.delta >= 0 ? "+" : ""}${overall.delta} |`);
