#!/usr/bin/env node
// fleet-reaper.mjs — scale to zero, then delete, dedicated deployments that are
// past the TTL their owning arm declared. Dry-run by default.
//
// Every deployment must carry the owner/TTL tags described in
// skills/reap-idle-deployments/SKILL.md. A deployment missing that signal is
// reported as `review` and never touched: an arm that is still running must not
// be taken down because its tags are absent.
//
// Usage:
//   FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs                 # dry-run
//   FIREWORKS_API_KEY=... node scripts/fleet-reaper.mjs --apply --yes   # act
//   node scripts/fleet-reaper.mjs --deployments fixture.json --json     # offline plan
//
// Flags: --account, --grace-hours, --delete-after-hours (or `never`),
//        --protect <owner|arm|name> (repeatable), --json, --apply, --yes.
// Exit codes: 0 planned/applied, 1 error, 2 usage.

import { readFileSync } from "node:fs";

import { normalizeDeployments, readDeploymentList } from "../dist/fleet/deployments.js";
import { formatReapPlan, planReap } from "../dist/fleet/reaper.js";
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
    "usage: fleet-reaper.mjs [--account <a>] [--deployments <fixture.json>] [--grace-hours <h>] [--delete-after-hours <h|never>] [--protect <owner|arm|name>]... [--json] [--apply --yes]",
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
  const raw = fixture ? readDeploymentList(JSON.parse(readFileSync(fixture, "utf8"))) : await listDeployments(config);
  const plan = planReap({
    deployments: normalizeDeployments(raw),
    policy: {
      graceHours: positiveHours("--grace-hours", argValue("--grace-hours"), undefined),
      deleteAfterHours: deleteAfterRaw === "never" ? null : positiveHours("--delete-after-hours", deleteAfterRaw, undefined),
      protect: argValues("--protect"),
    },
  });

  const applied = [];
  if (apply) {
    for (const decision of plan.decisions) {
      if (decision.action === "scale-to-zero") {
        await scaleDeploymentToZero(config, decision.name);
      } else if (decision.action === "delete") {
        await deleteDeployment(config, decision.name);
      } else {
        continue;
      }
      applied.push({ name: decision.name, action: decision.action });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ account: fixture ? null : account, mode: apply ? "apply" : "dry-run", ...plan, applied }, null, 2));
    return;
  }
  console.log(formatReapPlan(plan, { apply }));
  if (apply) {
    console.log(`applied: ${applied.length} action(s)`);
  } else if (plan.counts["scale-to-zero"] + plan.counts.delete > 0) {
    console.log("re-run with --apply --yes to execute these actions.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
