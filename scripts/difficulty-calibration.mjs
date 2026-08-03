#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCalibrationReport } from "../dist/difficulty-calibration.js";
const value = (name, fallback = null) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? (() => { throw new Error(`${name} requires a value`); })(); };
const input = value("--run"); if (!input) throw new Error("--run is required");
const raw = readFileSync(input); const parsed = JSON.parse(raw); const rows = Array.isArray(parsed) ? parsed : parsed.rows; if (!Array.isArray(rows)) throw new Error(`${input} has no rows[]`);
const report = buildCalibrationReport(rows, { model: parsed.model ?? null, split: parsed.split ?? null, threshold: value("--threshold") === null ? undefined : Number(value("--threshold")), minSample: value("--min-sample") === null ? undefined : Number(value("--min-sample")), source: { path: input, sha256: createHash("sha256").update(raw).digest("hex") } });
for (const [band, s] of Object.entries(report.bands)) console.log(`${band}: ${s.status} (${s.scored}/${s.tasks}, headroom=${s.headroom ?? "n/a"})`);
console.log(`Verdict: ${report.gate.worth_investing ? "invest" : "do not invest"}`);
const out = value("--out"); if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); }
