#!/usr/bin/env node
/**
 * Re-score existing AutomationBench v2 zero-shot reports by difficulty band.
 *
 * This is intentionally offline: it reads report JSON files and derives bands
 * from the committed task-family mapping. It never calls a model or provider.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { v2TaskBands } from "../dist/automationbench-v2.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

function positionalValues() {
  const values = [];
  const flagsWithValues = new Set(["--base", "--candidate", "--out", "--file"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (flagsWithValues.has(value)) {
      index += 1;
    } else if (!value.startsWith("--")) {
      values.push(value);
    }
  }
  return values;
}

const basePath = argValue("--base");
const candidatePath = argValue("--candidate");
const inputPaths = [...positionalValues(), ...argValues("--file")];
if (!basePath && !candidatePath && inputPaths.length === 0) {
  throw new Error("provide one or more report files, or --base <file> [--candidate <file>]");
}
if (candidatePath && !basePath) throw new Error("--candidate requires --base");

const outPath = argValue("--out");
const jsonOutput = process.argv.includes("--json");
const bands = v2TaskBands();

function familyForRow(row) {
  if (typeof row.family === "string") return row.family;
  if (typeof row.task_id !== "string") return null;
  return row.task_id.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "");
}

function load(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(report.rows)) throw new Error(`${path} does not contain a rows array`);
  return { path, report };
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(input) {
  const groups = {};
  const scored = input.report.rows.filter((row) => typeof row.score === "number");
  for (const row of scored) {
    const family = familyForRow(row);
    const band = bands[family] ?? row.band ?? "unknown";
    (groups[band] ??= []).push(row);
  }
  const byBand = Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([band, rows]) => [
    band,
    {
      n: rows.length,
      mean_score: mean(rows.map((row) => row.score)),
      exact_1_rate: rows.filter((row) => row.score === 1).length / rows.length,
      zero_rate: rows.filter((row) => row.score === 0).length / rows.length,
      malformed_rate: rows.filter((row) => Number(row.malformed) > 0).length / rows.length,
      mean_steps: mean(rows.map((row) => Number(row.steps) || 0)),
      forbidden_effects: rows.reduce((sum, row) => sum + (Number(row.forbidden_effects) || 0), 0),
    },
  ]));
  const all = scored;
  return {
    source: input.path,
    model: input.report.model ?? null,
    split: input.report.split ?? null,
    overall: {
      n: all.length,
      mean_score: mean(all.map((row) => row.score)),
      malformed_rate: all.filter((row) => Number(row.malformed) > 0).length / all.length,
      mean_steps: mean(all.map((row) => Number(row.steps) || 0)),
      forbidden_effects: all.reduce((sum, row) => sum + (Number(row.forbidden_effects) || 0), 0),
    },
    by_band: byBand,
  };
}

function delta(base, candidate) {
  const bandNames = [...new Set([...Object.keys(base.by_band), ...Object.keys(candidate.by_band)])].sort();
  const value = (record, key) => record?.[key] ?? null;
  const deltaValue = (candidateValue, baseValue) => (
    candidateValue === null || baseValue === null ? null : candidateValue - baseValue
  );
  return {
    base: base.source,
    candidate: candidate.source,
    overall: {
      mean_score: deltaValue(candidate.overall.mean_score, base.overall.mean_score),
      malformed_rate: deltaValue(candidate.overall.malformed_rate, base.overall.malformed_rate),
      mean_steps: deltaValue(candidate.overall.mean_steps, base.overall.mean_steps),
      forbidden_effects: deltaValue(candidate.overall.forbidden_effects, base.overall.forbidden_effects),
    },
    by_band: Object.fromEntries(bandNames.map((band) => {
      const left = base.by_band[band];
      const right = candidate.by_band[band];
      return [band, {
        n: { base: left?.n ?? 0, candidate: right?.n ?? 0 },
        mean_score: deltaValue(value(right, "mean_score"), value(left, "mean_score")),
        exact_1_rate: deltaValue(value(right, "exact_1_rate"), value(left, "exact_1_rate")),
        zero_rate: deltaValue(value(right, "zero_rate"), value(left, "zero_rate")),
        malformed_rate: deltaValue(value(right, "malformed_rate"), value(left, "malformed_rate")),
        mean_steps: deltaValue(value(right, "mean_steps"), value(left, "mean_steps")),
        forbidden_effects: deltaValue(value(right, "forbidden_effects"), value(left, "forbidden_effects")),
      }];
    })),
  };
}

const reports = (basePath && candidatePath)
  ? { comparison: delta(summarize(load(basePath)), summarize(load(candidatePath))) }
  : { reports: inputPaths.map((path) => summarize(load(path))) };
const output = JSON.stringify(reports, null, 2);

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${output}\n`);
}

if (jsonOutput || outPath) {
  console.log(output);
} else if (reports.comparison) {
  console.log("band                         Δscore       Δexact-1    Δzero       Δmalformed  Δsteps      Δforbidden");
    for (const [band, row] of Object.entries(reports.comparison.by_band)) {
    console.log(`${band.padEnd(28)} ${format(row.mean_score)} ${format(row.exact_1_rate)} ${format(row.zero_rate)} ${format(row.malformed_rate)} ${format(row.mean_steps)} ${format(row.forbidden_effects)}`);
    }
  console.log(`overall                      ${format(reports.comparison.overall.mean_score)}                         ${format(reports.comparison.overall.malformed_rate)} ${format(reports.comparison.overall.mean_steps)} ${format(reports.comparison.overall.forbidden_effects)}`);
} else {
  for (const report of reports.reports) {
    console.log(`\n${report.source} (${report.split ?? "unknown"})`);
    console.log("band                         n    mean_score   exact-1     zero        malformed   mean_steps  forbidden");
    for (const [band, row] of Object.entries(report.by_band)) {
      console.log(`${band.padEnd(28)} ${String(row.n).padStart(3)}  ${format(row.mean_score)} ${format(row.exact_1_rate)} ${format(row.zero_rate)} ${format(row.malformed_rate)} ${format(row.mean_steps)} ${String(row.forbidden_effects).padStart(9)}`);
    }
  }
}

function format(value) {
  return value === null ? "       -" : value.toFixed(4).padStart(8);
}
