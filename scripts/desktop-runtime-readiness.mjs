#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appBinary = resolve(
  process.env.UNDERSTUDY_DESKTOP_BINARY ||
    join(
      repoRoot,
      "apps/homescreen/src-tauri/target/debug/bundle/macos/Understudy.app/Contents/MacOS/understudy",
    ),
);
const cli = join(repoRoot, "dist/bin.js");
const database =
  process.env.UNDERSTUDY_DESKTOP_DB ||
  join(homedir(), "Library/Application Support/com.homescreen.app/understudy.db");
const baseUrl = process.env.UNDERSTUDY_DESKTOP_URL || "http://127.0.0.1:17790";
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;

if (process.argv.includes("--help")) {
  process.stdout.write(
    "usage: node scripts/desktop-runtime-readiness.mjs [--output <private-json>]\n" +
      "\n" +
      "Run after stopping Understudy and its warm model processes. The probe launches the\n" +
      "debug app bundle, cold-starts the managed runtime, measures restored models, and\n" +
      "leaves the measured app running. No provider calls are made.\n",
  );
  process.exit(0);
}
if (outputIndex >= 0 && !output) {
  throw new Error("--output requires a path");
}

const thresholds = {
  app_ready_ms: 2_500,
  runtime_ready_ms: 3_000,
  max_model_load_ms: 45_000,
  app_plus_runtime_rss_mb: 750,
  total_model_rss_gb: 32,
};

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result.stdout.trim();
}

function sqlite(query) {
  return run("sqlite3", ["-json", database, query]);
}

function sqliteRows(query) {
  const raw = sqlite(query);
  return raw ? JSON.parse(raw) : [];
}

function rssKb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

function listenerPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const pid = Number(result.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function healthReady() {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 300);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, label) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const result = await check();
    if (result) return { elapsed_ms: Math.round(performance.now() - started), result };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

if (!existsSync(appBinary)) {
  throw new Error(`desktop binary is missing: ${appBinary}`);
}
if (!existsSync(cli)) {
  throw new Error(`built CLI is missing: ${cli}; run npm run build first`);
}
if (!existsSync(database)) {
  throw new Error(`desktop database is missing: ${database}`);
}
if (await healthReady()) {
  throw new Error(`desktop is already serving at ${baseUrl}; stop it before a cold readiness run`);
}

const warmBefore = sqliteRows(
  "SELECT slot_id, model_id, port, server_pid, mem_gb FROM residency WHERE warm=1 ORDER BY slot_id",
);
const liveOrphans = warmBefore.filter((slot) => processAlive(Number(slot.server_pid)));
if (liveOrphans.length > 0) {
  throw new Error(
    `warm model processes are still alive for slots ${liveOrphans.map((slot) => slot.slot_id).join(", ")}; stop them before measuring cold startup`,
  );
}

// A cold runtime measurement must not reuse a managed sidecar from a prior app
// process. Stopping it is local-only and does not delete sessions or evidence.
spawnSync(process.execPath, [cli, "runtime", "stop", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});

const launchStarted = performance.now();
const app = spawn(appBinary, [], {
  cwd: repoRoot,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    UNDERSTUDY_BIN: cli,
  },
});
app.unref();

let result;
try {
  const appReady = await waitFor(healthReady, 10_000, "desktop HTTP server");
  const token = run("sqlite3", [database, "SELECT value FROM settings WHERE key='server_token'"]);
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error("desktop server token is missing or malformed");
  }
  const authorization = { authorization: `Bearer ${token}` };

  const runtimeStarted = performance.now();
  const runtimeRaw = run(
    process.execPath,
    [cli, "runtime", "start", "--json"],
    {
      env: {
        ...process.env,
        UNDERSTUDY_RUNTIME_TOOL_TOKEN: token,
        UNDERSTUDY_RUNTIME_TOOL_BASE_URL: baseUrl,
      },
    },
  );
  const runtime = JSON.parse(runtimeRaw);
  const runtimeReadyMs = Math.round(performance.now() - runtimeStarted);
  if (!runtime.healthy || !runtime.running) {
    throw new Error(`conversation runtime did not become healthy: ${runtime.detail}`);
  }

  const warmIds = new Set(warmBefore.map((slot) => Number(slot.slot_id)));
  const modelReady = await waitFor(
    async () => {
      const response = await fetchWithTimeout(`${baseUrl}/api/residency`, {
        headers: authorization,
      });
      if (!response.ok) throw new Error(`residency returned HTTP ${response.status}`);
      const snapshot = await response.json();
      const warm = snapshot.slots.filter((slot) => warmIds.has(Number(slot.id)));
      if (warm.some((slot) => slot.state === "error")) {
        throw new Error(
          `restored model error in slots ${warm.filter((slot) => slot.state === "error").map((slot) => slot.id).join(", ")}`,
        );
      }
      return warm.length === warmIds.size && warm.every((slot) => slot.state === "running")
        ? snapshot
        : null;
    },
    90_000,
    "restored local models",
  );
  const modelsReadyFromLaunchMs = Math.round(performance.now() - launchStarted);

  const warmAfter = sqliteRows(
    "SELECT slot_id, model_id, port, server_pid, mem_gb FROM residency WHERE warm=1 ORDER BY slot_id",
  );
  const models = warmAfter.map((slot) => {
    const persistedPid = Number(slot.server_pid);
    const pid = processAlive(persistedPid) ? persistedPid : listenerPid(Number(slot.port));
    const rss = rssKb(pid);
    const view = modelReady.result.slots.find((candidate) => Number(candidate.id) === Number(slot.slot_id));
    return {
      slot_id: Number(slot.slot_id),
      model_id: slot.model_id,
      port: Number(slot.port),
      pid,
      load_ms: view?.load_ms ?? null,
      declared_mem_gb: Number(slot.mem_gb),
      rss_gb: rss === null ? null : rss / 1024 / 1024,
    };
  });
  const appRssKb = rssKb(app.pid);
  const runtimeRssKb = rssKb(Number(runtime.pid));
  const appPlusRuntimeRssMb =
    appRssKb === null || runtimeRssKb === null ? null : (appRssKb + runtimeRssKb) / 1024;
  const totalModelRssGb = models.reduce((sum, model) => sum + (model.rss_gb ?? 0), 0);
  const maxModelLoadMs = Math.max(0, ...models.map((model) => Number(model.load_ms) || 0));
  const checks = {
    app_ready: appReady.elapsed_ms <= thresholds.app_ready_ms,
    runtime_ready: runtimeReadyMs <= thresholds.runtime_ready_ms,
    models_ready: maxModelLoadMs <= thresholds.max_model_load_ms,
    app_plus_runtime_memory:
      appPlusRuntimeRssMb !== null && appPlusRuntimeRssMb <= thresholds.app_plus_runtime_rss_mb,
    model_memory:
      models.every((model) => model.rss_gb !== null) &&
      totalModelRssGb <= thresholds.total_model_rss_gb,
  };
  result = {
    schema_version: "understudy-desktop-runtime-readiness-v1",
    generated_at: new Date().toISOString(),
    measurement_class: "process-cold-filesystem-warm",
    caveat:
      "The app, sidecar, and model server processes were cold, but model weights may remain in the macOS filesystem cache. This is not a reboot-cold measurement.",
    passed: Object.values(checks).every(Boolean),
    thresholds,
    checks,
    app: {
      pid: app.pid,
      ready_ms: appReady.elapsed_ms,
      rss_mb: appRssKb === null ? null : appRssKb / 1024,
    },
    runtime: {
      pid: Number(runtime.pid),
      runtime_version: runtime.runtime_version,
      event_schema: runtime.event_schema,
      ready_ms: runtimeReadyMs,
      rss_mb: runtimeRssKb === null ? null : runtimeRssKb / 1024,
    },
    restored_models_ready_ms: modelsReadyFromLaunchMs,
    residency_poll_ms: modelReady.elapsed_ms,
    app_plus_runtime_rss_mb: appPlusRuntimeRssMb,
    total_model_rss_gb: totalModelRssGb,
    models,
  };
} catch (error) {
  if (processAlive(app.pid)) process.kill(app.pid, "SIGTERM");
  throw error;
}

const rendered = `${JSON.stringify(result, null, 2)}\n`;
if (output) writeFileSync(resolve(output), rendered, { mode: 0o600 });
process.stdout.write(rendered);
if (!result.passed) process.exitCode = 1;
