#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) throw new Error(`${name} is required`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const basePath = argValue("--base");
const candidatePath = argValue("--candidate");
const outPath = argValue("--out");
const base = JSON.parse(readFileSync(basePath, "utf8"));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
if (base.fixture_id !== candidate.fixture_id) throw new Error("base and candidate fixture ids differ");
if (base.split !== candidate.split) throw new Error("base and candidate split names differ");
if (base.split_sha256 !== candidate.split_sha256) throw new Error("base and candidate split hashes differ");

const summarize = (artifact) => {
  const bands = {};
  for (const row of artifact.rows ?? []) {
    const band = row.band ?? "unknown";
    const bucket = bands[band] ??= { episodes: 0, score_sum: 0, passes: 0, fabrications: 0, over_budget: 0 };
    bucket.episodes += 1;
    bucket.score_sum += Number(row.score) || 0;
    bucket.passes += row.score === 1 ? 1 : 0;
    bucket.fabrications += row.fabrication ? 1 : 0;
    bucket.over_budget += row.over_budget ? 1 : 0;
  }
  return Object.fromEntries(Object.entries(bands).map(([band, values]) => [
    band,
    {
      episodes: values.episodes,
      mean_score: values.episodes ? values.score_sum / values.episodes : 0,
      pass_rate: values.episodes ? values.passes / values.episodes : 0,
      fabrication_episodes: values.fabrications,
      over_budget_episodes: values.over_budget,
    },
  ]));
};

const baseBands = summarize(base);
const candidateBands = summarize(candidate);
const bands = [...new Set([...Object.keys(baseBands), ...Object.keys(candidateBands)])].sort();
const report = {
  schema_version: "understudy.grounded_chat_band_report.v1",
  fixture_id: candidate.fixture_id,
  split: candidate.split,
  split_sha256: candidate.split_sha256,
  base: baseBands,
  candidate: candidateBands,
  deltas: Object.fromEntries(bands.map((band) => {
    const b = baseBands[band] ?? {};
    const c = candidateBands[band] ?? {};
    return [band, {
      mean_score: (c.mean_score ?? 0) - (b.mean_score ?? 0),
      pass_rate: (c.pass_rate ?? 0) - (b.pass_rate ?? 0),
      fabrication_episodes: (c.fabrication_episodes ?? 0) - (b.fabrication_episodes ?? 0),
      over_budget_episodes: (c.over_budget_episodes ?? 0) - (b.over_budget_episodes ?? 0),
    }];
  })),
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
