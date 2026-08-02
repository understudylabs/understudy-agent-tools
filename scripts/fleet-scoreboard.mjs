#!/usr/bin/env node
// fleet-scoreboard.mjs — rank training arms on both axes that matter during a
// parallel sweep: verifier score and live burn in $/hr.
//
// The verifier reward says which arm is working; $/hr says what the sweep is
// costing right now. Ranking on one axis alone is how a scaled-up arm with no
// score keeps burning unnoticed.
//
// Usage:
//   FIREWORKS_API_KEY=... node scripts/fleet-scoreboard.mjs [--account understudy-dev] [--scores scores.json] [--json]
//   node scripts/fleet-scoreboard.mjs --deployments fixture.json --scores scores.json   # offline
//
// --scores takes a JSON array (or { scores: [...] }) of
//   { "arm": "arm-a", "score": 0.71, "split": "dev", "deployment": "optional-name" }
// Deployments are matched by the `understudy.arm` tag, then by name.

import { readFileSync } from "node:fs";

import { buildScoreboard, formatScoreboard } from "../dist/fleet/scoreboard.js";
import { normalizeDeployments, readDeploymentList } from "../dist/fleet/deployments.js";
import { listDeployments } from "../dist/fleet/provider.js";

const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (args.includes("--help")) {
  console.log(
    "usage: fleet-scoreboard.mjs [--account <account>] [--scores <scores.json>] [--deployments <fixture.json>] [--json]",
  );
  process.exit(0);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readScores(path) {
  if (!path) return [];
  const body = readJson(path);
  const rows = Array.isArray(body) ? body : body.scores;
  if (!Array.isArray(rows)) throw new Error("--scores must be a JSON array or { scores: [...] }");
  return rows.map((row) => {
    if (!row || typeof row.arm !== "string" || typeof row.score !== "number") {
      throw new Error("each score needs { arm: string, score: number }");
    }
    return row;
  });
}

async function main() {
  const fixture = argValue("--deployments");
  const account = argValue("--account") || process.env.FIREWORKS_ACCOUNT || "understudy-dev";
  const raw = fixture
    ? readDeploymentList(readJson(fixture))
    : await listDeployments({ account, apiKey: requireApiKey() });
  const scoreboard = buildScoreboard({
    deployments: normalizeDeployments(raw),
    scores: readScores(argValue("--scores")),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ account: fixture ? null : account, ...scoreboard }, null, 2));
    return;
  }
  if (!fixture) console.log(`account: ${account}   (rates are estimates; provider billing is authoritative)`);
  console.log(formatScoreboard(scoreboard));
}

function requireApiKey() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    console.error("FIREWORKS_API_KEY is required (never hard-code it), or pass --deployments <fixture.json>.");
    process.exit(2);
  }
  return apiKey;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
