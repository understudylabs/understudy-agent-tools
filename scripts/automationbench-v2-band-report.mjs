#!/usr/bin/env node
/**
 * Per-band comparison of two AutomationBench v2 offline runs.
 *
 * Reads the run JSON emitted by `scripts/automationbench-v2-zeroshot.mjs` (any
 * two runs over the same split) and reports, per difficulty band:
 *
 *   - outcome-first mean score (terminal final-state partial credit),
 *   - exact-1 and zero rates,
 *   - OVER-ACTION counts: episodes that wrote outside `allowedWrites`
 *     (`forbidden_effects > 0`) and the raw forbidden-write total,
 *   - malformed-emission counts.
 *
 * Over-action is reported as a count, not only a rate, because the regression
 * it guards against (a tuned policy that starts writing extra records) is rare
 * per episode and invisible in a rounded rate.
 *
 * This script only reads finished run artifacts. It never samples a model,
 * never touches the fixture pools, and so cannot read the sealed holdout.
 *
 * Usage:
 *   node scripts/automationbench-v2-band-report.mjs \
 *     --base outputs/base-nemotron-dev.json \
 *     --candidate outputs/dpo-nemotron-dev.json \
 *     --out outputs/band-report-dev.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { v2TaskBands } from "../dist/automationbench-v2.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const basePath = argValue("--base");
const candidatePath = argValue("--candidate");
if (!basePath) throw new Error("--base is required");
const outPath = argValue("--out");

const BANDS = v2TaskBands();

const readRun = (path) => {
  const run = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(run.rows)) throw new Error(`${path} has no rows[]; re-run with --out to keep per-task rows`);
  return run;
};

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Group rows by reporting band. Scoring never reads the band; this is presentation only. */
function summarize(run) {
  const byBand = new Map();
  for (const row of run.rows) {
    const band = row.band ?? BANDS[row.family] ?? "unknown";
    const bucket = byBand.get(band) ?? { rows: [] };
    bucket.rows.push(row);
    byBand.set(band, bucket);
  }
  const bands = {};
  for (const [band, bucket] of [...byBand.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const scored = bucket.rows.filter((row) => typeof row.score === "number");
    bands[band] = {
      tasks: bucket.rows.length,
      scored: scored.length,
      mean_score: mean(scored.map((row) => row.score)),
      exact_1: scored.filter((row) => row.score === 1).length,
      zero: scored.filter((row) => row.score === 0).length,
      over_acting_episodes: bucket.rows.filter((row) => (row.forbidden_effects ?? 0) > 0).length,
      forbidden_writes: bucket.rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
      malformed_episodes: bucket.rows.filter((row) => (row.malformed ?? 0) > 0).length,
    };
  }
  const scored = run.rows.filter((row) => typeof row.score === "number");
  return {
    model: run.model,
    split: run.split,
    split_sha256: run.split_sha256,
    tasks: run.rows.length,
    mean_score: mean(scored.map((row) => row.score)),
    over_acting_episodes: run.rows.filter((row) => (row.forbidden_effects ?? 0) > 0).length,
    forbidden_writes: run.rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    malformed_episodes: run.rows.filter((row) => (row.malformed ?? 0) > 0).length,
    bands,
  };
}

const base = summarize(readRun(basePath));
const candidate = candidatePath ? summarize(readRun(candidatePath)) : null;

if (candidate && base.split !== candidate.split) {
  throw new Error(`split mismatch: base=${base.split} candidate=${candidate.split}`);
}
if (candidate && base.split_sha256 !== candidate.split_sha256) {
  throw new Error("split hash mismatch: the two runs did not score the same frozen split");
}

const delta = (a, b) => (typeof a === "number" && typeof b === "number" ? b - a : null);

const report = {
  schema_version: "understudy.automationbench_band_report.v1",
  generated_at: new Date().toISOString(),
  split: base.split,
  split_sha256: base.split_sha256,
  base,
  candidate,
  per_band_delta: candidate
    ? Object.fromEntries(
        Object.keys(base.bands).map((band) => [
          band,
          {
            tasks: base.bands[band].tasks,
            base_mean: base.bands[band].mean_score,
            candidate_mean: candidate.bands[band]?.mean_score ?? null,
            delta_mean: delta(base.bands[band].mean_score, candidate.bands[band]?.mean_score),
            base_over_acting_episodes: base.bands[band].over_acting_episodes,
            candidate_over_acting_episodes: candidate.bands[band]?.over_acting_episodes ?? null,
            base_forbidden_writes: base.bands[band].forbidden_writes,
            candidate_forbidden_writes: candidate.bands[band]?.forbidden_writes ?? null,
          },
        ]),
      )
    : null,
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
