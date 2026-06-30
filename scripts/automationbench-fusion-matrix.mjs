#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:17890/v1";
const DEFAULT_EVENT_LOG = ".understudy/fusion-benchmark/proxy-events.jsonl";
const DEFAULT_BENCH_DIR = "/Users/luis/Developer/understudy/AutomationBench";

function usage() {
  return `Usage:
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> [--dry-run]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --run [--only <labels>] [--bench-dir <path>] [--out-dir <dir>] [--event-log <path>]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --ingest [--only <labels>] [--out-dir <dir>] [--event-log <path>] [--post] [--token <token>]

Runs or ingests the Understudy Fusion AutomationBench matrix:
  local-main, local-fast, gateway-glm, fusion-main, fusion-sidekick-parallel,
  fusion-sidekick-advisory, fusion-routing

Use --dry-run to print the exact auto-bench and ingestion commands without executing.
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function shellQuote(value) {
  const string = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+~$-]+$/.test(string)) return string;
  return `'${string.replaceAll("'", "'\\''")}'`;
}

function matrix(baseUrl = DEFAULT_PROXY_BASE_URL) {
  return [
    {
      label: "local-main",
      model: "gemma-4-26b-a4b-it-qat-mlx-vlm-understudy",
      baseUrl: "http://127.0.0.1:8091/v1",
      apiKey: "local",
      candidate: "local-main",
    },
    {
      label: "local-fast",
      model: "gemma-4-e2b-it-qat-mlx-vlm-understudy",
      baseUrl: "http://127.0.0.1:8092/v1",
      apiKey: "local",
      candidate: "local-fast",
    },
    {
      label: "gateway-glm",
      model: "glm-5.2",
      baseUrl: "$UNDERSTUDY_GATEWAY_BASE_URL/v1",
      apiKey: "$UNDERSTUDY_GATEWAY_API_KEY",
      candidate: "gateway-glm",
    },
    {
      label: "fusion-main",
      model: "understudy-fusion-main",
      baseUrl,
      apiKey: "fusion",
      candidate: null,
    },
    {
      label: "fusion-sidekick-parallel",
      model: "understudy-fusion-sidekick-main",
      baseUrl,
      apiKey: "fusion",
      candidate: null,
    },
    {
      label: "fusion-sidekick-advisory",
      model: "understudy-fusion-sidekick-advisory-main",
      baseUrl,
      apiKey: "fusion",
      candidate: null,
    },
    {
      label: "fusion-routing",
      model: "understudy-fusion-routing",
      baseUrl,
      apiKey: "fusion",
      candidate: null,
      fusionEventLog: true,
    },
  ];
}

function selectedRuns(args) {
  const only = argValue(args, "--only");
  const runs = matrix(argValue(args, "--base-url") ?? DEFAULT_PROXY_BASE_URL);
  if (!only) return runs;
  const labels = new Set(
    only
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  );
  const selected = runs.filter((run) => labels.has(run.label));
  if (selected.length !== labels.size) {
    const known = new Set(runs.map((run) => run.label));
    const missing = [...labels].filter((label) => !known.has(label));
    throw new Error(`unknown matrix label(s): ${missing.join(", ")}`);
  }
  return selected;
}

function loadHandoff(path) {
  if (!existsSync(path)) throw new Error(`handoff not found: ${path}`);
  const handoff = JSON.parse(readFileSync(path, "utf8"));
  if (handoff.schema_version !== "understudy.automationbench_handoff.v1") {
    throw new Error(`unsupported handoff schema: ${handoff.schema_version ?? "missing"}`);
  }
  return handoff;
}

function resolveBenchDir(args) {
  const explicit = argValue(args, "--bench-dir");
  if (explicit) return resolve(explicit);
  if (existsSync("pyproject.toml") && readFileSync("pyproject.toml", "utf8").includes("auto-bench")) {
    return process.cwd();
  }
  if (existsSync(DEFAULT_BENCH_DIR)) return DEFAULT_BENCH_DIR;
  return process.cwd();
}

function outputPath(outDir, handoff, run) {
  return resolve(outDir, `understudy-automationbench-${handoff.run_id}-${run.label}.json`);
}

function executionValue(value) {
  const match = String(value).match(/^\$([A-Z0-9_]+)(.*)$/);
  if (!match) return value;
  const envValue = process.env[match[1]];
  if (!envValue) throw new Error(`${match[1]} is required to run ${value}`);
  return `${envValue}${match[2]}`;
}

function autoBenchArgs(handoff, run, outDir, options = {}) {
  const baseUrl = options.execution ? executionValue(run.baseUrl) : run.baseUrl;
  const apiKey = options.execution ? executionValue(run.apiKey) : run.apiKey;
  return [
    "run",
    "auto-bench",
    "--model",
    run.model,
    "--base-url",
    baseUrl,
    "--api-key",
    apiKey,
    "--domains",
    handoff.domains.join(","),
    "--num-examples",
    String(handoff.num_examples),
    "--max-concurrent",
    "1",
    "--max-steps",
    "10",
    "--toolset",
    "api",
    "--export-json",
    outputPath(outDir, handoff, run),
    "--save-every",
    "-1",
  ];
}

function ingestArgs(handoffPath, handoff, run, outDir, eventLog, args) {
  const values = [
    "scripts/automationbench-handoff-runner.mjs",
    "--handoff",
    handoffPath,
    "--results",
    outputPath(outDir, handoff, run),
    "--cohort-run-id",
    handoff.run_id,
  ];
  if (run.candidate) values.push("--candidate", run.candidate);
  if (run.fusionEventLog) values.push("--fusion-event-log", eventLog);
  if (args.includes("--post")) values.push("--post");
  const token = argValue(args, "--token");
  if (token) values.push("--token", token);
  return values;
}

function commandString(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function printDryRun({ handoffPath, handoff, runs, benchDir, outDir, eventLog, args }) {
  console.log(`# AutomationBench Fusion matrix: ${handoff.run_id}`);
  console.log(`# bench_dir=${benchDir}`);
  console.log(`# outputs=${outDir}`);
  console.log(`# event_log=${eventLog}`);
  console.log(`# Start proxy first: FUSION_PROXY_EVENT_LOG=${shellQuote(eventLog)} node scripts/automationbench-fusion-proxy.mjs --port 17890`);
  for (const run of runs) {
    console.log("");
    console.log(`# ${run.label}`);
    console.log(`cd ${shellQuote(benchDir)} && ${commandString("uv", autoBenchArgs(handoff, run, outDir))}`);
    console.log(commandString("node", ingestArgs(handoffPath, handoff, run, outDir, eventLog, args)));
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = options.capture ? result.stderr : "";
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return result;
}

function runMatrix({ handoff, runs, benchDir, outDir }) {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(benchDir)) throw new Error(`AutomationBench directory not found: ${benchDir}`);
  for (const run of runs) {
    console.error(`running ${run.label}`);
    runCommand("uv", autoBenchArgs(handoff, run, outDir, { execution: true }), { cwd: benchDir });
  }
}

function ingestMatrix({ handoffPath, handoff, runs, outDir, eventLog, args }) {
  for (const run of runs) {
    const path = outputPath(outDir, handoff, run);
    if (!existsSync(path)) throw new Error(`missing result export for ${run.label}: ${path}`);
    console.error(`ingesting ${run.label}`);
    runCommand("node", ingestArgs(handoffPath, handoff, run, outDir, eventLog, args));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(usage());
    return;
  }
  const handoffPath = argValue(args, "--handoff");
  if (!handoffPath) throw new Error("--handoff is required");
  const handoff = loadHandoff(handoffPath);
  const benchDir = resolveBenchDir(args);
  const outDir = resolve(argValue(args, "--out-dir") ?? ".understudy/fusion-benchmark/runs");
  const eventLog = resolve(argValue(args, "--event-log") ?? DEFAULT_EVENT_LOG);
  const runs = selectedRuns(args);
  if (args.includes("--dry-run") || (!args.includes("--run") && !args.includes("--ingest"))) {
    printDryRun({ handoffPath, handoff, runs, benchDir, outDir, eventLog, args });
    return;
  }
  if (args.includes("--run")) runMatrix({ handoff, runs, benchDir, outDir });
  if (args.includes("--ingest")) ingestMatrix({ handoffPath, handoff, runs, outDir, eventLog, args });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
