#!/usr/bin/env node
/**
 * Quantization-for-serving decision report.
 *
 * Joins, per precision lane, the verifier runs emitted by
 * `scripts/automationbench-v2-zeroshot.mjs` (dev and sealed holdout) with the
 * serving measurements emitted by `throughput-probe.mjs`, and applies the
 * PREDECLARED quality tolerance below to recommend a serving precision.
 *
 * The tolerance is declared in code, and committed, before the holdout is read:
 * a lane cannot be waved through by loosening the bar after seeing its score.
 *
 * This script only reads finished artifacts. It never samples a model and never
 * touches the fixture pools, so it cannot read the sealed holdout itself.
 *
 * Usage:
 *   node experiments/nemotron-quant-serving/quant-cost-report.mjs \
 *     --reference bf16 \
 *     --lane bf16:outputs/quant-bf16-dev.json:outputs/quant-bf16-holdout.json:outputs/throughput-bf16.json \
 *     --lane fp8:outputs/quant-fp8-dev.json:outputs/quant-fp8-holdout.json:outputs/throughput-fp8.json \
 *     --out outputs/quant-serving-report.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * PREDECLARED QUALITY TOLERANCE (fixed before the holdout was read).
 *
 * A cheaper precision is only recommendable when all four hold against the
 * reference precision, on the same frozen splits:
 */
export const TOLERANCE = {
  // Headline outcome score may not fall by more than this on dev...
  dev_mean_drop: 0.02,
  // ...nor by more than this on the sealed holdout (read once).
  holdout_mean_drop: 0.03,
  // No single difficulty band may collapse, even if the mean survives.
  band_mean_drop: 0.05,
  // Safety is not tradeable: writing outside `allowedWrites` may not increase.
  forbidden_write_increase: 0,
};

function argValues(name) {
  const values = [];
  process.argv.forEach((token, index) => {
    if (token === name) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  });
  return values;
}

function argValue(name, fallback = null) {
  const values = argValues(name);
  return values.length === 0 ? fallback : values[0];
}

const referenceLane = argValue("--reference", "bf16");
const outPath = argValue("--out");
const laneSpecs = argValues("--lane");
if (laneSpecs.length === 0) throw new Error("at least one --lane <name>:<dev>:<holdout>:<throughput> is required");

const readJson = (path) => (path && path !== "-" ? JSON.parse(readFileSync(path, "utf8")) : null);
const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Per-band means and safety counters for one verifier run. */
function summarize(run) {
  if (!run) return null;
  const scored = run.rows.filter((row) => typeof row.score === "number");
  const byBand = new Map();
  for (const row of scored) {
    const bucket = byBand.get(row.band) ?? [];
    bucket.push(row.score);
    byBand.set(row.band, bucket);
  }
  return {
    model: run.model,
    split: run.split,
    split_sha256: run.split_sha256,
    tasks: run.rows.length,
    mean_score: mean(scored.map((row) => row.score)),
    exact_1_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 1).length / scored.length,
    zero_rate: scored.length === 0 ? null : scored.filter((row) => row.score === 0).length / scored.length,
    forbidden_writes: run.rows.reduce((sum, row) => sum + (row.forbidden_effects ?? 0), 0),
    malformed_episodes: run.rows.filter((row) => (row.malformed ?? 0) > 0).length,
    completion_tokens: run.rows.reduce((sum, row) => sum + (row.completion_tokens ?? 0), 0),
    mean_by_band: Object.fromEntries(
      [...byBand.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([band, scores]) => [band, mean(scores)]),
    ),
  };
}

const lanes = laneSpecs.map((spec) => {
  const [name, devPath, holdoutPath, throughputPath] = spec.split(":");
  if (!name || !devPath) throw new Error(`--lane must be <name>:<dev>[:<holdout>[:<throughput>]], got ${spec}`);
  return {
    name,
    dev: summarize(readJson(devPath)),
    holdout: summarize(readJson(holdoutPath)),
    serving: readJson(throughputPath),
  };
});

const reference = lanes.find((lane) => lane.name === referenceLane);
if (!reference) throw new Error(`reference lane ${referenceLane} is not among the supplied lanes`);

for (const lane of lanes) {
  for (const split of ["dev", "holdout"]) {
    const a = reference[split];
    const b = lane[split];
    if (a && b && a.split_sha256 !== b.split_sha256) {
      throw new Error(`${lane.name} scored a different ${split} split than ${referenceLane}`);
    }
  }
}

const drop = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : null);

function verdict(lane) {
  if (lane.name === reference.name) {
    return { within_tolerance: true, reason: "reference precision", breaches: [] };
  }
  const breaches = [];
  const devDrop = drop(reference.dev?.mean_score, lane.dev?.mean_score);
  if (devDrop === null) breaches.push("dev run missing");
  else if (devDrop > TOLERANCE.dev_mean_drop) breaches.push(`dev mean -${devDrop.toFixed(3)} > ${TOLERANCE.dev_mean_drop}`);

  const holdoutDrop = drop(reference.holdout?.mean_score, lane.holdout?.mean_score);
  if (holdoutDrop === null) breaches.push("holdout run missing");
  else if (holdoutDrop > TOLERANCE.holdout_mean_drop) {
    breaches.push(`holdout mean -${holdoutDrop.toFixed(3)} > ${TOLERANCE.holdout_mean_drop}`);
  }

  for (const split of ["dev", "holdout"]) {
    const bands = reference[split]?.mean_by_band ?? {};
    for (const [band, referenceMean] of Object.entries(bands)) {
      const bandDrop = drop(referenceMean, lane[split]?.mean_by_band?.[band]);
      if (bandDrop !== null && bandDrop > TOLERANCE.band_mean_drop) {
        breaches.push(`${split} band ${band} -${bandDrop.toFixed(3)} > ${TOLERANCE.band_mean_drop}`);
      }
    }
    const extraWrites = drop(lane[split]?.forbidden_writes, reference[split]?.forbidden_writes);
    if (extraWrites !== null && extraWrites > TOLERANCE.forbidden_write_increase) {
      breaches.push(`${split} forbidden writes +${extraWrites}`);
    }
  }

  return { within_tolerance: breaches.length === 0, breaches };
}

const rows = lanes.map((lane) => {
  const peak = lane.serving?.peak_output_tokens_per_s ?? null;
  const usdPerHour = lane.serving?.gpu_usd_per_hour ?? null;
  return {
    precision: lane.name,
    gpu: lane.serving?.gpu ?? null,
    dev_mean: lane.dev?.mean_score ?? null,
    holdout_mean: lane.holdout?.mean_score ?? null,
    dev_delta_vs_reference: drop(lane.dev?.mean_score, reference.dev?.mean_score),
    holdout_delta_vs_reference: drop(lane.holdout?.mean_score, reference.holdout?.mean_score),
    forbidden_writes: (lane.dev?.forbidden_writes ?? 0) + (lane.holdout?.forbidden_writes ?? 0),
    peak_output_tokens_per_s: peak,
    gpu_usd_per_hour: usdPerHour,
    usd_per_million_output_tokens: lane.serving?.usd_per_million_output_tokens ?? null,
    throughput_vs_reference:
      peak && reference.serving?.peak_output_tokens_per_s
        ? Number((peak / reference.serving.peak_output_tokens_per_s).toFixed(2))
        : null,
    ...verdict(lane),
  };
});

// Cheapest per output token among the lanes that cleared the predeclared bar.
const eligible = rows.filter((row) => row.within_tolerance && row.usd_per_million_output_tokens !== null);
const recommended = eligible.sort(
  (a, b) => a.usd_per_million_output_tokens - b.usd_per_million_output_tokens,
)[0];

const report = {
  schema_version: "understudy.quant_serving_report.v1",
  generated_at: new Date().toISOString(),
  reference_precision: reference.name,
  tolerance: TOLERANCE,
  lanes: rows,
  recommended_precision: recommended?.precision ?? null,
  recommendation_basis: recommended
    ? `cheapest $/1M output tokens among lanes within the predeclared tolerance (${recommended.usd_per_million_output_tokens} $/1M at ${recommended.peak_output_tokens_per_s} tok/s on ${recommended.gpu})`
    : "no lane cleared the predeclared tolerance with a measured price",
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
