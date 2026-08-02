#!/usr/bin/env node
// fleet-reaper.mjs — scale to zero, then delete, dedicated deployments that are
// past the TTL their owning arm declared. Dry-run by default.
//
// Every deployment must carry the owner/TTL tags described in
// skills/reap-idle-deployments/SKILL.md. A deployment missing that signal is
// reported as `review` and never touched: an arm that is still running must not
// be taken down because its tags are absent.
//
// This is a thin caller of the idempotent `runFleetReapStep` — the same step a
// durable workflow invokes directly. With --artifact-dir it writes the immutable
// understudy.fleet_scoreboard.v1 / understudy.fleet_reap_plan.v1 artifacts and
// prints their refs (uri + sha256).
//
// Usage:
//   FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs                 # dry-run
//   FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs --apply --yes   # act
//   node scripts/fleet-reaper.mjs --deployments fixture.json --json     # offline plan
//
// Flags: --account, --grace-hours, --delete-after-hours (or `never`),
//        --protect <owner|arm|name> (repeatable), --experiment-id, --candidate,
//        --attempt, --artifact-dir, --json, --apply, --yes.
// Exit codes: 0 planned/applied, 1 error, 2 usage.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readDeploymentList } from "../dist/fleet/deployments.js";
import { formatReapPlan } from "../dist/fleet/reaper.js";
import { artifactRef, canonicalJson } from "../dist/fleet/artifacts.js";
import { runFleetReapStep } from "../dist/fleet/step.js";
import { deleteDeployment, listDeployments, scaleDeploymentToZero } from "../dist/fleet/provider.js";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usageExit(`${name} requires a value`);
  return value;
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usageExit(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function usageExit(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: fleet-reaper.mjs [--account <a>] [--deployments <fixture.json>] [--grace-hours <h>] [--delete-after-hours <h|never>] [--protect <owner|arm|name>]... [--experiment-id <id>] [--candidate <id>] [--attempt <n>] [--artifact-dir <dir>] [--json] [--apply --yes]",
  );
  process.exit(2);
}

if (args.includes("--help")) usageExit();

function positiveHours(name, raw, fallback) {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) usageExit(`${name} must be a non-negative number`);
  return value;
}

const fixture = argValue("--deployments");
const account = argValue("--account") || process.env.FIREWORKS_ACCOUNT || "understudy-dev";
const asJson = args.includes("--json");
const apply = args.includes("--apply");
const deleteAfterRaw = argValue("--delete-after-hours");

if (apply && !args.includes("--yes")) usageExit("--apply also requires --yes");
if (apply && fixture) usageExit("--apply cannot be combined with --deployments (offline fixture)");

async function main() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!fixture && !apiKey) {
    console.error("FIREWORKS_API_KEY is required (never hard-code it), or pass --deployments <fixture.json>.");
    process.exit(2);
  }
  const config = { account, apiKey: apiKey ?? "" };
  const controlPlane = {
    listDeployments: async () => (fixture ? readDeploymentList(JSON.parse(readFileSync(fixture, "utf8"))) : listDeployments(config)),
    scaleToZero: (name) => scaleDeploymentToZero(config, name),
    deleteDeployment: (name) => deleteDeployment(config, name),
  };
  const attempt = Number(argValue("--attempt", "0"));
  if (!Number.isInteger(attempt) || attempt < 0) usageExit("--attempt must be a non-negative integer");

  const result = await runFleetReapStep({
    controlPlane,
    experimentId: argValue("--experiment-id", "local"),
    candidateId: argValue("--candidate"),
    attempt,
    account: fixture ? null : account,
    apply,
    policy: {
      graceHours: positiveHours("--grace-hours", argValue("--grace-hours"), undefined),
      deleteAfterHours: deleteAfterRaw === "never" ? null : positiveHours("--delete-after-hours", deleteAfterRaw, undefined),
      protect: argValues("--protect"),
    },
  });
  const refs = writeArtifacts(argValue("--artifact-dir"), result);

  if (asJson) {
    console.log(JSON.stringify({ ...result, refs }, null, 2));
    return;
  }
  console.log(formatReapPlan(planShape(result.plan), { apply }));
  if (apply) {
    console.log(`applied: ${result.plan.applied.length} action(s)`);
  } else if (result.plan.counts["scale-to-zero"] + result.plan.counts.delete > 0) {
    console.log("re-run with --apply --yes to execute these actions.");
  }
  for (const ref of refs) console.log(`artifact ${ref.schema_version} ${ref.uri} sha256=${ref.sha256}`);
}

/** Write both artifacts and return their content-addressed refs. */
function writeArtifacts(dir, result) {
  if (!dir) return [];
  mkdirSync(dir, { recursive: true });
  return [
    ["fleet-scoreboard.json", result.scoreboard],
    ["fleet-reap-plan.json", result.plan],
  ].map(([file, artifact]) => {
    const path = join(resolve(dir), file);
    writeFileSync(path, `${canonicalJson(artifact)}\n`);
    return artifactRef(artifact, pathToFileURL(path).href);
  });
}

/** The artifact is snake_case on the wire; the renderer takes the planner shape. */
function planShape(plan) {
  return {
    generatedAt: plan.generated_at,
    policy: plan.policy,
    counts: plan.counts,
    savingsUsdPerHr: plan.savings_usd_per_hr,
    decisions: plan.decisions.map((decision) => ({
      name: decision.name,
      action: decision.action,
      reason: decision.reason,
      owner: decision.owner,
      arm: decision.arm,
      usdPerHr: decision.usd_per_hr,
      overdueHours: decision.overdue_hours,
    })),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
