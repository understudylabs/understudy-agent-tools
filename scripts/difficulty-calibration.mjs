#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildCalibrationReport } from "../dist/difficulty-calibration.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const runPath = argValue("--run");
if (!runPath) throw new Error("--run is required");

const fixture = argValue("--fixture", "auto");
if (!["auto", "v1", "v2"].includes(fixture)) throw new Error("--fixture must be auto, v1, or v2");

const rawRun = readFileSync(runPath);
const run = JSON.parse(rawRun.toString("utf8"));
const rows = Array.isArray(run) ? run : run.rows;
if (!Array.isArray(rows)) throw new Error(`${runPath} has no rows[]`);

const report = buildCalibrationReport(rows, {
  fixture,
  model: typeof run.model === "string" ? run.model : null,
  split: typeof run.split === "string" ? run.split : null,
  threshold: argValue("--threshold") === null ? undefined : Number(argValue("--threshold")),
  minSample: argValue("--min-sample") === null ? undefined : Number(argValue("--min-sample")),
  source: {
    path: runPath,
    sha256: createHash("sha256").update(rawRun).digest("hex"),
  },
});

console.log(`Difficulty calibration: ${report.model ?? "unknown model"}`);
console.log(`Fixture: ${report.fixture}  Split: ${report.split ?? "unknown"}  Scored: ${report.overall.scored}/${report.overall.tasks}`);
console.log("Band                 Tasks  Scored  Mean    Headroom  Status              Verdict");
for (const [band, summary] of Object.entries(report.bands)) {
  const mean = summary.mean_score === null ? "n/a" : summary.mean_score.toFixed(3);
  const headroom = summary.headroom === null ? "n/a" : summary.headroom.toFixed(3);
  console.log(`${band.padEnd(20)} ${String(summary.tasks).padStart(5)} ${String(summary.scored).padStart(7)} ${mean.padStart(6)} ${headroom.padStart(9)}  ${summary.status.padEnd(19)} ${summary.verdict}`);
}
console.log(`\nVerdict: ${report.gate.worth_investing ? "invest" : "do not invest"}`);
console.log(report.gate.reason);

const outPath = argValue("--out");
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
