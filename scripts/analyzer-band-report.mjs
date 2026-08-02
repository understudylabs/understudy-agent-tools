#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
};
const basePath = arg("--base");
const candidatePath = arg("--candidate");
const outPath = arg("--out");
if (!basePath) throw new Error("--base is required");
const base = JSON.parse(readFileSync(basePath, "utf8"));
const candidate = candidatePath ? JSON.parse(readFileSync(candidatePath, "utf8")) : null;
if (candidate && (candidate.split !== base.split || candidate.split_sha256 !== base.split_sha256)) {
  throw new Error("refusing to compare artifacts with different split or split_sha256");
}
const rows = (artifact) => artifact.rows ?? [];
const scoredRows = (items) => items.filter((row) => !row.forbidden?.includes("request_error"));
const mean = (items) => items.length ? items.reduce((sum, row) => sum + Number(row.score ?? 0), 0) / items.length : 0;
const metrics = (items) => {
  const scored = scoredRows(items);
  return {
  scored_row_count: scored.length,
      request_error_episodes: items.length - scored.length,
      task_count: new Set(scored.map((row) => row.task_id)).size,
      strict_format_rate: scored.length ? scored.filter((row) => row.strict_format).length / scored.length : 0,
      mean_score: mean(scored),
  exact_1_count: scored.filter((row) => row.score === 1).length,
  zero_count: scored.filter((row) => row.score === 0).length,
  over_claim_episodes: scored.filter((row) => row.forbidden?.includes("over_claim")).length,
  hallucinated_citation_episodes: scored.filter((row) => row.forbidden?.includes("hallucinated_citation")).length,
  invalid_output_episodes: scored.filter((row) => row.forbidden?.includes("invalid_output")).length,
  };
};
const bands = [...new Set([...rows(base), ...(candidate ? rows(candidate) : [])].map((row) => row.band).filter(Boolean))].sort();
const sideBySide = (band) => {
  const baseMetrics = metrics(rows(base).filter((row) => !band || row.band === band));
  const candidateMetrics = candidate ? metrics(rows(candidate).filter((row) => !band || row.band === band)) : null;
  const delta = candidateMetrics ? Object.fromEntries(Object.keys(baseMetrics).map((key) => [key, Number(candidateMetrics[key] ?? 0) - Number(baseMetrics[key] ?? 0)])) : null;
  return { base: baseMetrics, candidate: candidateMetrics, delta };
};
const report = {
  fixture_id: base.fixture_id, split: base.split, split_sha256: base.split_sha256,
  overall: sideBySide(null),
  per_band: Object.fromEntries(bands.map((band) => [band, sideBySide(band)])),
};
const baseBad = metrics(rows(base)).over_claim_episodes + metrics(rows(base)).hallucinated_citation_episodes;
const candidateBad = candidate ? metrics(rows(candidate)).over_claim_episodes + metrics(rows(candidate)).hallucinated_citation_episodes : 0;
report.verdict = candidate && candidateBad > baseBad ? "REGRESSION: candidate adds over-claim or hallucinated-citation episodes" : "pass";
if (outPath) { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report, null, 2));
if (report.verdict.startsWith("REGRESSION")) process.exitCode = 2;
