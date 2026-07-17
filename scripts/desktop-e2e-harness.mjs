#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDir, "..");

const REPORT_SCHEMA = "understudy.desktop_e2e_harness.v1";
const CAPABILITY_SCHEMA = "understudy.desktop_api.v2";
const MAX_CSV_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_APP_LOG_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

function isoCompact() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function privateDirectory(path) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`private artifact path is not a regular directory: ${path}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`private artifact directory permissions are too broad: ${path}`);
    }
    return path;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function prepareRunRoot(path) {
  const target = resolve(path);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Desktop E2E output directory must be empty: ${target}`);
  }
  return privateDirectory(target);
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePrivateText(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function pathInside(root, path) {
  const candidate = relative(root, resolve(path));
  return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate);
}

function artifactReference(runRoot, path) {
  if (!path || !pathInside(runRoot, path)) return null;
  return relative(runRoot, resolve(path));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function boundedText(value, limit = 4_096) {
  return String(value ?? "").trim().slice(0, limit);
}

function redactedDiagnostic(value, replacements) {
  let result = boundedText(value);
  for (const [candidate, replacement] of replacements
    .filter(([candidate]) => typeof candidate === "string" && candidate.length > 0)
    .sort((left, right) => right[0].length - left[0].length)) {
    result = result.replaceAll(candidate, replacement);
  }
  return result;
}

function sleep(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

function parseArgvJson(value, label) {
  if (!value) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON array of argv strings`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty JSON array of argv strings`);
  }
  return parsed;
}

function statusSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = {};
  for (const key of [
    "app",
    "app_version",
    "runtime_version",
    "repair_required",
    "runtime_ready",
    "cli_ready",
  ]) {
    if (["string", "number", "boolean"].includes(typeof value[key])) summary[key] = value[key];
  }
  if (Array.isArray(value.models)) summary.model_count = value.models.length;
  if (Array.isArray(value.slots)) summary.residency_slot_count = value.slots.length;
  return summary;
}

function appendBounded(chunks, chunk, state) {
  if (state.bytes >= MAX_APP_LOG_BYTES) {
    state.truncated = true;
    return;
  }
  const bytes = Buffer.from(chunk);
  const remaining = MAX_APP_LOG_BYTES - state.bytes;
  chunks.push(bytes.subarray(0, remaining));
  state.bytes += Math.min(bytes.length, remaining);
  if (bytes.length > remaining) state.truncated = true;
}

function signalChildGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
  child.kill(signal);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  signalChildGroup(child, "SIGTERM");
  await Promise.race([
    new Promise((accept) => child.once("exit", accept)),
    sleep(2_000),
  ]);
  if (child.exitCode === null) signalChildGroup(child, "SIGKILL");
}

async function startFakeDesktopApi(capabilityPath) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: CAPABILITY_SCHEMA,
        api_version: "2.2.0",
        event_schema: "understudy-conversation-runtime-event-v1",
      }));
      return;
    }
    if (request.url === "/v1/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        app: "running",
        app_version: "test-double",
        runtime_ready: true,
        cli_ready: true,
        repair_required: false,
      }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  privateDirectory(dirname(capabilityPath));
  writePrivateJson(capabilityPath, {
    schema_version: CAPABILITY_SCHEMA,
    api_version: "2.2.0",
    base_url: baseUrl,
    pid: process.pid,
    app_version: "test-double",
    token,
  });
  return {
    close: () => new Promise((accept) => server.close(accept)),
  };
}

async function waitForCapability(path, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child?.exitCode !== null) {
      throw new Error(`Desktop exited with status ${child.exitCode} before publishing its API capability`);
    }
    await sleep(100);
  }
  throw new Error(`Desktop API capability did not appear within ${timeoutMs}ms`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDesktopCapability(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Desktop API capability must be a regular file");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Desktop API capability must use owner-only permissions");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.schema_version !== CAPABILITY_SCHEMA) {
    throw new Error(`Desktop API capability schema is ${value?.schema_version ?? "missing"}`);
  }
  const url = new URL(value.base_url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/") {
    throw new Error("Desktop API capability must point to an exact loopback origin");
  }
  if (typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("Desktop API capability has no valid bearer token");
  }
  if (!Number.isInteger(value.pid) || value.pid <= 0) {
    throw new Error("Desktop API capability has no valid pid");
  }
  if (!pidAlive(value.pid)) {
    throw new Error(`Desktop API capability is stale: pid ${value.pid} is not running`);
  }
  return { baseUrl: url.origin, token: value.token, appVersion: value.app_version ?? null };
}

async function apiJson(capability, path, timeoutMs) {
  const response = await fetch(new URL(path, capability.baseUrl), {
    headers: { authorization: `Bearer ${capability.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Desktop API ${path} returned ${response.status}`);
  return response.json();
}

async function inspectDesktopApi(capability, timeoutMs) {
  const health = await fetch(new URL("/health", capability.baseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!health.ok) throw new Error(`Desktop health returned ${health.status}`);
  const capabilities = await apiJson(capability, "/v1/capabilities", timeoutMs);
  let status;
  try {
    status = await apiJson(capability, "/v1/status", timeoutMs);
  } catch (error) {
    if (!String(error.message).includes("returned 404")) throw error;
    status = await apiJson(capability, "/api/status", timeoutMs);
  }
  return {
    healthy: true,
    schema_version: capabilities?.schema_version ?? null,
    api_version: capabilities?.api_version ?? null,
    app_version: capability.appVersion,
    status: statusSummary(status),
  };
}

async function runCliJson({ cliPath, args, cwd, env, label, events, timeoutMs }) {
  const started = Date.now();
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    });
    events.push({
      type: "command",
      label,
      status: "ok",
      elapsed_ms: Date.now() - started,
      stdout_bytes: Buffer.byteLength(result.stdout),
      stderr_bytes: Buffer.byteLength(result.stderr),
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    events.push({
      type: "command",
      label,
      status: "error",
      elapsed_ms: Date.now() - started,
      stdout_bytes: Buffer.byteLength(error.stdout ?? ""),
      stderr_bytes: Buffer.byteLength(error.stderr ?? ""),
    });
    throw new Error(`${label} failed: ${boundedText(error.stderr || error.message)}`);
  }
}

async function captureScreenshot(command, output, cwd, events) {
  if (!command) return null;
  privateDirectory(dirname(output));
  const argv = command.map((item) => item.replaceAll("{output}", output));
  if (!argv.some((item) => item.includes(output))) {
    throw new Error("screenshot command must contain the {output} placeholder");
  }
  const started = Date.now();
  await execFileAsync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true,
  });
  const size = statSync(output).size;
  if (size > MAX_SCREENSHOT_BYTES) {
    rmSync(output, { force: true });
    throw new Error(`screenshot exceeded ${MAX_SCREENSHOT_BYTES} bytes`);
  }
  events.push({ type: "screenshot", status: "ok", elapsed_ms: Date.now() - started, bytes: size });
  return output;
}

function validateTable(path) {
  const canonical = realpathSync(path);
  const metadata = statSync(canonical);
  const extension = extname(canonical).toLowerCase();
  if (!metadata.isFile() || !["", ".csv", ".tsv", ".tab", ".txt"].includes(extension)) {
    throw new Error("Desktop E2E requires one local delimited text file");
  }
  if (metadata.size > MAX_CSV_BYTES) {
    throw new Error(`Table exceeds the harness limit of ${MAX_CSV_BYTES} bytes`);
  }
  return { path: canonical, bytes: metadata.size };
}

function verifyLocalBoundary(value, fields) {
  if (value?.local_only !== true) throw new Error("workload step did not preserve local_only=true");
  for (const field of fields) {
    if (!value?.[field]) throw new Error(`workload step omitted ${field}`);
  }
}

function makeIsolatedEnv(runRoot) {
  const home = privateDirectory(join(runRoot, "home"));
  return {
    ...process.env,
    HOME: home,
    UNDERSTUDY_DESKTOP_API_FILE: join(home, ".understudy", "desktop-api.json"),
    UNDERSTUDY_DATA_ROOT: privateDirectory(join(runRoot, "data")),
    UNDERSTUDY_STATE_ROOT: privateDirectory(join(runRoot, "state")),
    UNDERSTUDY_TELEMETRY: "0",
    UNDERSTUDY_NETWORK_MODE: "offline",
    HF_HUB_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
}

export async function runDesktopE2EHarness({
  root = repositoryRoot,
  mode = "fake",
  csvPath,
  outputRoot,
  capabilityPath,
  appCommand = null,
  screenshotCommand = null,
  labelColumn = null,
  groupColumn = null,
  inputColumns = [],
  acceptRecommendedMapping = false,
  timeoutMs = 30_000,
} = {}) {
  if (!csvPath) throw new Error("csvPath is required");
  if (!['fake', 'real'].includes(mode)) throw new Error("mode must be fake or real");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("timeoutMs must be an integer from 1000 through 120000");
  }
  if (mode === "fake" && appCommand) throw new Error("fake mode does not accept an app command");
  if (mode === "real" && !appCommand && !capabilityPath) {
    throw new Error("real mode requires appCommand or an explicit existing capabilityPath");
  }
  const runId = `desktop-e2e-${isoCompact()}-${randomBytes(3).toString("hex")}`;
  const runRoot = prepareRunRoot(
    resolve(outputRoot ?? join(root, ".understudy", "desktop-e2e", runId)),
  );
  const artifactsRoot = privateDirectory(join(runRoot, "artifacts"));
  const evidenceRoot = privateDirectory(join(runRoot, "evidence"));
  const screenshotRoot = privateDirectory(join(evidenceRoot, "screenshots"));
  const env = makeIsolatedEnv(runRoot);
  const launchedCapabilityPath = capabilityPath
    ? resolve(capabilityPath)
    : env.UNDERSTUDY_DESKTOP_API_FILE;
  if ((mode === "fake" || appCommand) && !pathInside(runRoot, launchedCapabilityPath)) {
    throw new Error("a harness-owned Desktop capability must stay inside the private run root");
  }
  const ownsCapability = mode === "fake" || Boolean(appCommand);
  const events = [];
  const states = [];
  const errors = [];
  const screenshots = [];
  const appLogChunks = [];
  const appLogState = { bytes: 0, truncated: false };
  let fakeServer = null;
  let appChild = null;
  let report;

  const transition = (state, detail = null) => {
    const row = { state, at: new Date().toISOString() };
    if (detail) row.detail = detail;
    states.push(row);
    events.push({ type: "state", ...row });
  };

  transition("idle");
  try {
    const source = validateTable(csvPath);
    const sourceSha256 = await sha256File(source.path);
    transition("launching", mode === "fake" ? "CI desktop API test double" : "real Desktop");
    if (mode === "fake") {
      fakeServer = await startFakeDesktopApi(launchedCapabilityPath);
    } else if (appCommand) {
      appChild = spawn(appCommand[0], appCommand.slice(1), {
        cwd: root,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      appChild.stdout.on("data", (chunk) => appendBounded(appLogChunks, chunk, appLogState));
      appChild.stderr.on("data", (chunk) => appendBounded(appLogChunks, chunk, appLogState));
    }
    await waitForCapability(launchedCapabilityPath, timeoutMs, appChild);
    const capability = readDesktopCapability(launchedCapabilityPath);
    const desktopApi = await inspectDesktopApi(capability, Math.min(timeoutMs, 5_000));
    transition("connected");
    const connectedScreenshot = await captureScreenshot(
      screenshotCommand,
      join(screenshotRoot, "01-connected.png"),
      root,
      events,
    );
    if (connectedScreenshot) screenshots.push(artifactReference(runRoot, connectedScreenshot));

    const cliPath = join(root, "dist", "bin.js");
    if (!existsSync(cliPath)) {
      throw new Error("dist/bin.js is missing; run npm run build before the Desktop E2E harness");
    }
    transition("validating");
    transition("compiling");
    const compiled = await runCliJson({
      cliPath,
      args: [
        "capture-import",
        "compile",
        "--source",
        source.path,
        "--output-root",
        artifactsRoot,
        "--json",
      ],
      cwd: root,
      env,
      label: "compile dropped workload",
      events,
      timeoutMs,
    });
    verifyLocalBoundary(compiled, ["artifact_root", "workload_card_path"]);
    if (compiled.payload_read !== false || !pathInside(artifactsRoot, compiled.artifact_root)) {
      throw new Error("metadata compile crossed its local metadata-only boundary");
    }

    transition("inspecting");
    const inspection = await runCliJson({
      cliPath,
      args: [
        "capture-import",
        "inspect-csv",
        "--source",
        source.path,
        "--artifact-root",
        compiled.artifact_root,
        "--json",
      ],
      cwd: root,
      env,
      label: "inspect dropped CSV",
      events,
      timeoutMs,
    });
    verifyLocalBoundary(inspection, ["source_sha256", "artifact_path", "recommended_mapping"]);
    if (
      inspection.payload_read !== true ||
      inspection.source_rows_persisted !== false ||
      inspection.source_sha256 !== sourceSha256
    ) {
      throw new Error("CSV inspection evidence does not match the exact local source");
    }
    const inspectedScreenshot = await captureScreenshot(
      screenshotCommand,
      join(screenshotRoot, "02-inspected.png"),
      root,
      events,
    );
    if (inspectedScreenshot) screenshots.push(artifactReference(runRoot, inspectedScreenshot));

    const selectedLabel = labelColumn ?? inspection.recommended_mapping?.label_column ?? null;
    const selectedGroup = groupColumn ?? inspection.recommended_mapping?.group_column ?? null;
    const selectedInputs = inputColumns.length > 0
      ? inputColumns
      : inspection.recommended_mapping?.input_columns ?? [];
    const explicitMapping = Boolean(labelColumn) && Boolean(groupColumn) && inputColumns.length > 0;
    let dataset = null;
    if (!inspection.training_readiness?.ready) {
      transition("blocked", inspection.training_readiness?.status ?? "not ready");
      errors.push(...(inspection.training_readiness?.reasons ?? ["CSV is not ready for training"]));
    } else if (!selectedLabel || !selectedGroup || selectedInputs.length === 0) {
      transition("awaiting_mapping", "label, leakage group, or input columns are ambiguous");
      errors.push("Confirm one label, one leakage group, and at least one input column.");
    } else if (!explicitMapping && !acceptRecommendedMapping) {
      transition("awaiting_mapping", "recommended mapping requires explicit acceptance");
      errors.push("Pass explicit columns or acceptRecommendedMapping=true.");
    } else {
      transition("preparing");
      const prepareArgs = [
        "capture-import",
        "prepare-classification",
        "--source",
        source.path,
        "--artifact-root",
        compiled.artifact_root,
        "--label-column",
        selectedLabel,
        "--group-column",
        selectedGroup,
      ];
      for (const column of selectedInputs) prepareArgs.push("--input-column", column);
      prepareArgs.push("--json");
      dataset = await runCliJson({
        cliPath,
        args: prepareArgs,
        cwd: root,
        env,
        label: "prepare deterministic classification dataset",
        events,
        timeoutMs,
      });
      verifyLocalBoundary(dataset, ["dataset_id", "manifest_path", "splits"]);
      if (
        dataset.network_required !== false ||
        dataset.source_sha256 !== sourceSha256 ||
        !pathInside(artifactsRoot, dataset.manifest_path)
      ) {
        throw new Error("prepared dataset crossed its local deterministic boundary");
      }
      for (const [name, split] of Object.entries(dataset.splits)) {
        if (!pathInside(artifactsRoot, split.path)) {
          throw new Error(`${name} split escaped the private artifact root`);
        }
        const actual = await sha256File(split.path);
        if (actual !== split.sha256) throw new Error(`${name} split hash does not match its manifest`);
      }
      transition("ready");
      const readyScreenshot = await captureScreenshot(
        screenshotCommand,
        join(screenshotRoot, "03-ready.png"),
        root,
        events,
      );
      if (readyScreenshot) screenshots.push(artifactReference(runRoot, readyScreenshot));
    }

    report = {
      schema_version: REPORT_SCHEMA,
      run_id: runId,
      generated_at: new Date().toISOString(),
      ok: states.at(-1)?.state === "ready" && errors.length === 0,
      terminal_state: states.at(-1)?.state,
      mode,
      validation_level: mode === "real" ? "real-desktop-api" : "desktop-api-test-double",
      run_root: runRoot,
      source: {
        name: basename(source.path),
        bytes: source.bytes,
        sha256: sourceSha256,
        raw_rows_embedded_in_report: false,
      },
      desktop_api: desktopApi,
      workload: {
        artifact_root: artifactReference(runRoot, compiled.artifact_root),
        workload_card: artifactReference(runRoot, compiled.workload_card_path),
        inspection: artifactReference(runRoot, inspection.artifact_path),
        row_count: inspection.row_count,
        column_count: inspection.column_count,
        training_readiness: inspection.training_readiness,
        recommended_mapping: inspection.recommended_mapping,
      },
      dataset: dataset
        ? {
            dataset_id: dataset.dataset_id,
            manifest: artifactReference(runRoot, dataset.manifest_path),
            row_count: dataset.row_count,
            mapping: dataset.mapping,
            mapping_sha256: dataset.mapping_sha256,
            splits: Object.fromEntries(Object.entries(dataset.splits).map(([name, split]) => [
              name,
              {
                path: artifactReference(runRoot, split.path),
                row_count: split.row_count,
                sha256: split.sha256,
              },
            ])),
          }
        : null,
      states,
      screenshots,
      coverage: {
        production_cli_compile: true,
        production_cli_csv_inspection: true,
        production_cli_dataset_preparation: dataset !== null,
        authenticated_desktop_api: true,
        native_drag_event: false,
        rive_pixel_assertion: false,
        sqlite_state_inspection: false,
      },
      known_gaps: [
        "The current Desktop API cannot synthesize a native Tauri file-drop event.",
        "Rive state and rendered pixels require an explicit window-scoped screenshot command or UI driver.",
        "The current status API does not expose the isolated native SQLite path for direct verification.",
      ],
      privacy: {
        local_only: true,
        telemetry_disabled: true,
        offline_environment_requested: true,
        dataset_uploaded: false,
        secrets_in_report: false,
      },
      errors,
    };
  } catch (error) {
    transition("failed");
    errors.push(redactedDiagnostic(error.message, [
      [launchedCapabilityPath, "<capability>"],
      [runRoot, "<run-root>"],
      [resolve(csvPath), "<csv>"],
      [root, "<repo>"],
    ]));
    report = {
      schema_version: REPORT_SCHEMA,
      run_id: runId,
      generated_at: new Date().toISOString(),
      ok: false,
      terminal_state: "failed",
      mode,
      validation_level: mode === "real" ? "real-desktop-api" : "desktop-api-test-double",
      run_root: runRoot,
      source: csvPath ? { name: basename(csvPath), raw_rows_embedded_in_report: false } : null,
      states,
      screenshots,
      coverage: {
        native_drag_event: false,
        rive_pixel_assertion: false,
      },
      privacy: {
        local_only: true,
        telemetry_disabled: true,
        offline_environment_requested: true,
        dataset_uploaded: false,
        secrets_in_report: false,
      },
      errors,
    };
  } finally {
    await stopChild(appChild);
    if (fakeServer) await fakeServer.close();
    if (ownsCapability) rmSync(launchedCapabilityPath, { force: true });
    if (appLogChunks.length > 0) {
      const suffix = appLogState.truncated ? "\n[understudy harness: log truncated]\n" : "";
      writePrivateText(join(evidenceRoot, "app.log"), Buffer.concat(appLogChunks).toString("utf8") + suffix);
    }
    writePrivateText(
      join(evidenceRoot, "events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    report.cleanup = {
      launched_process_stopped: appChild ? appChild.exitCode !== null || appChild.killed : null,
      capability_removed: ownsCapability ? !existsSync(launchedCapabilityPath) : null,
      private_artifacts_preserved: true,
      app_log_truncated: appLogState.truncated,
    };
    report.artifacts = {
      report: "report.json",
      events: "evidence/events.jsonl",
      app_log: appLogChunks.length > 0 ? "evidence/app.log" : null,
    };
    writePrivateJson(join(runRoot, "report.json"), report);
  }
  return report;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function valuesAfter(args, flag) {
  return args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
}

const HELP = `Usage: desktop-e2e-harness --csv path [options]

Exercise the production CSV compiler and authenticated Desktop API contract, then write private local evidence.

Modes:
  --mode fake   Default. Use a local Desktop API test double; no native Desktop UI is exercised.
  --mode real   Connect to or launch the real Desktop API. This does not synthesize native Tauri
                drag/drop events or assert Rive animation/rendered pixels.

Options:
  --csv path                         Source CSV, TSV, TXT, or extensionless delimited table (required).
  --output path                      Private local evidence directory.
  --capability path                  Existing Desktop API capability file for real mode.
  --app-command-json '["cmd",...]'  Launch command for real mode.
  --screenshot-command-json '[...]'  Optional external screenshot command.
  --label-column name                Explicit target/label column.
  --group-column name                Explicit leakage-control grouping column.
  --input-column name                Explicit input column; repeat for multiple columns.
  --accept-recommended-mapping       Accept an unambiguous recommended mapping.
  --timeout-ms number                API/startup timeout (default: 30000).
  -h, --help                         Show this help and exit.
`;

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const csvPath = valueAfter(args, "--csv");
  if (!csvPath) {
    throw new Error(
      "usage: desktop-e2e-harness --csv path [--mode fake|real] [--accept-recommended-mapping]",
    );
  }
  const report = await runDesktopE2EHarness({
    mode: valueAfter(args, "--mode") ?? "fake",
    csvPath,
    outputRoot: valueAfter(args, "--output"),
    capabilityPath: valueAfter(args, "--capability"),
    appCommand: parseArgvJson(valueAfter(args, "--app-command-json"), "--app-command-json"),
    screenshotCommand: parseArgvJson(
      valueAfter(args, "--screenshot-command-json"),
      "--screenshot-command-json",
    ),
    labelColumn: valueAfter(args, "--label-column"),
    groupColumn: valueAfter(args, "--group-column"),
    inputColumns: valuesAfter(args, "--input-column"),
    acceptRecommendedMapping: args.includes("--accept-recommended-mapping"),
    timeoutMs: Number(valueAfter(args, "--timeout-ms") ?? 30_000),
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    terminal_state: report.terminal_state,
    report: join(report.run_root, "report.json"),
    errors: report.errors,
  }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
