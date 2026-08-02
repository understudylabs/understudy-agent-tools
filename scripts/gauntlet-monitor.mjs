#!/usr/bin/env node
// Gauntlet monitor: shows live dedicated deployments and estimated GPU burn.
//
// This is the burn-only view. The scoreboard in scripts/fleet-scoreboard.mjs
// joins the same rows against verifier scores and is the preferred entrypoint
// during a sweep; scripts/fleet-reaper.mjs acts on what is past its TTL.
//
// Usage:
//   FIREWORKS_API_KEY=... node scripts/gauntlet-monitor.mjs [--account understudy-dev] [--json]
//
// Successful checks exit 0; configuration or API errors exit nonzero. A nonzero
// LIVE burn is reported in the summary line so a wrapper can alert on it.

import { normalizeDeployments } from "../dist/fleet/deployments.js";
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
  console.log("Usage: FIREWORKS_API_KEY=... node scripts/gauntlet-monitor.mjs [--account <account>] [--json]");
  process.exit(0);
}

const account = argValue("--account") || process.env.FIREWORKS_ACCOUNT || "understudy-dev";
const asJson = args.includes("--json");
const apiKey = process.env.FIREWORKS_API_KEY;

if (!apiKey) {
  console.error("FIREWORKS_API_KEY is required (never hard-code it).");
  process.exit(2);
}

async function main() {
  const rows = normalizeDeployments(await listDeployments({ account, apiKey }));
  const live = rows.filter((row) => row.live).sort((a, b) => b.usdPerHr - a.usdPerHr);
  const totalBurn = live.reduce((sum, row) => sum + row.usdPerHr, 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        { account, generatedAt: new Date().toISOString(), liveCount: live.length, estBurnUsdPerHr: totalBurn, live, total: rows.length },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Fireworks account: ${account}   (rates are estimates; billing is authoritative)`);
  console.log(`STATE repl gpu accel                   usd/hr  name  <- baseModel`);
  for (const row of live) {
    console.log(
      `LIVE  ${String(row.replicas).padStart(4)} ${String(row.gpus).padStart(3)} ${row.accel.padEnd(22)} ${row.usdPerHr.toFixed(1).padStart(6)}  ${row.name}  <- ${row.baseModel}`,
    );
  }
  const zero = rows.length - live.length;
  console.log("");
  console.log(
    `TOTAL deployments: ${rows.length} | LIVE(replicas>0): ${live.length} | scaled-to-zero: ${zero} | est live burn ~$${totalBurn.toFixed(0)}/hr`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
