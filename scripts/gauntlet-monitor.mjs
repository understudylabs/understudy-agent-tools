#!/usr/bin/env node
// Gauntlet monitor: shows live Fireworks dedicated deployments and estimated GPU burn.
//
// The verifier reward (per-arm dev/holdout score) is the source of truth for
// "what is working"; this script answers the companion question — "what is still
// running and what is it costing right now" — so live GPU spend never goes unnoticed
// during a parallel provider sweep.
//
// Usage:
//   FIREWORKS_API_KEY=... node scripts/gauntlet-monitor.mjs [--account understudy-dev] [--json]
//
// Successful checks exit 0; configuration or API errors exit nonzero. A nonzero
// LIVE burn is reported in the summary line so a wrapper can alert on it.

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

// Rough on-demand per-GPU-hour rates (USD). Estimates only — Fireworks billing is
// authoritative. Used to surface relative burn, not to reconcile invoices.
const RATE_USD_PER_GPU_HR = {
  NVIDIA_B200_180GB: 15.0,
  NVIDIA_H200_141GB: 7.0,
  NVIDIA_H100_80GB: 5.5,
  NVIDIA_A100_80GB: 3.0,
};
const DEFAULT_RATE = 8.0;

async function main() {
  const url = `https://api.fireworks.ai/v1/accounts/${encodeURIComponent(account)}/deployments?pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    console.error(`Fireworks API error ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  const deployments = Array.isArray(body.deployments) ? body.deployments : [];

  const rows = deployments.map((d) => {
    const replicas = d.desiredReplicaCount || 0;
    const gpus = d.acceleratorCount || 0;
    const accel = d.acceleratorType || "";
    const rate = RATE_USD_PER_GPU_HR[accel] ?? DEFAULT_RATE;
    return {
      name: (d.name || "").split("/").pop(),
      baseModel: (d.baseModel || "").split("/").pop(),
      replicas,
      gpus,
      accel,
      usdPerHr: replicas * gpus * rate,
      live: replicas > 0,
      createTime: d.createTime,
    };
  });

  const live = rows.filter((r) => r.live).sort((a, b) => b.usdPerHr - a.usdPerHr);
  const totalBurn = live.reduce((s, r) => s + r.usdPerHr, 0);

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
  for (const r of live) {
    console.log(
      `LIVE  ${String(r.replicas).padStart(4)} ${String(r.gpus).padStart(3)} ${r.accel.padEnd(22)} ${r.usdPerHr.toFixed(1).padStart(6)}  ${r.name}  <- ${r.baseModel}`,
    );
  }
  const zero = rows.length - live.length;
  console.log("");
  console.log(
    `TOTAL deployments: ${rows.length} | LIVE(replicas>0): ${live.length} | scaled-to-zero: ${zero} | est live burn ~$${totalBurn.toFixed(0)}/hr`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
