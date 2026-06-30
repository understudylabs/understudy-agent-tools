#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:17890/v1";
const DEFAULT_EVENT_LOG = ".understudy/fusion-benchmark/proxy-events.jsonl";
const DEFAULT_BENCH_DIR = process.env.AUTOMATIONBENCH_DIR ?? resolve(homedir(), "AutomationBench");

function usage() {
  return `Usage:
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> [--dry-run] [--domains <domains>] [--num-examples <n>]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --run [--only <labels>] [--bench-dir <path>] [--out-dir <dir>] [--event-log <path>] [--domains <domains>] [--num-examples <n>] [--max-concurrent <n>] [--max-steps <n>] [--save-every <n>]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --ingest [--only <labels>] [--out-dir <dir>] [--event-log <path>] [--post] [--token <token>] [--domains <domains>] [--num-examples <n>]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --final-comparison --full [--run|--ingest]
  node scripts/automationbench-fusion-matrix.mjs --handoff <path> --final-comparison --preflight

Runs or ingests the Understudy Fusion AutomationBench matrix:
  local-main, local-fast, gateway-glm, fusion-main, fusion-sidekick-parallel,
  fusion-sidekick-advisory, fusion-routing

Use --dry-run to print the exact auto-bench and ingestion commands without executing.
Use --preflight to check selected model endpoints before a long run.
Use --final-comparison for the required final matrix: gateway-glm, local-main, local-fast.
Use --full to omit --num-examples and run the full selected AutomationBench domains.
Use --save-every for long full runs so partial progress is persisted.
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
  const labels = new Set(
    only
      ? only
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean)
      : args.includes("--final-comparison")
        ? ["gateway-glm", "local-main", "local-fast"]
        : [],
  );
  if (labels.size === 0) return runs;
  const selected = runs.filter((run) => labels.has(run.label));
  if (selected.length !== labels.size) {
    const known = new Set(runs.map((run) => run.label));
    const missing = [...labels].filter((label) => !known.has(label));
    throw new Error(`unknown matrix label(s): ${missing.join(", ")}`);
  }
  return selected;
}

function runConfig(handoff, args) {
  const full = args.includes("--full");
  if (full && args.includes("--num-examples")) {
    throw new Error("--full cannot be combined with --num-examples");
  }
  return {
    domains: argValue(args, "--domains") ?? handoff.domains.join(","),
    numExamples: full ? null : (argValue(args, "--num-examples") ?? String(handoff.num_examples)),
    maxConcurrent: argValue(args, "--max-concurrent") ?? "1",
    maxSteps: argValue(args, "--max-steps") ?? "10",
    saveEvery: argValue(args, "--save-every") ?? "-1",
  };
}

function configSuffixValue(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, "-");
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

function outputPath(outDir, handoff, run, config) {
  const handoffDomains = handoff.domains.join(",");
  const handoffExamples = String(handoff.num_examples);
  const suffix =
    config.domains === handoffDomains && config.numExamples === handoffExamples
      ? ""
      : `-${configSuffixValue(config.domains)}-${config.numExamples ?? "full"}`;
  return resolve(outDir, `understudy-automationbench-${handoff.run_id}${suffix}-${run.label}.json`);
}

function localGatewayCredentials() {
  const path = `${homedir()}/.understudy/credentials.json`;
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return {
      UNDERSTUDY_GATEWAY_BASE_URL: value.gateway_url,
      UNDERSTUDY_GATEWAY_API_KEY: value.api_key,
    };
  } catch {
    return {};
  }
}

function executionValue(value) {
  const match = String(value).match(/^\$([A-Z0-9_]+)(.*)$/);
  if (!match) return value;
  const envValue = process.env[match[1]] || localGatewayCredentials()[match[1]];
  if (!envValue) throw new Error(`${match[1]} is required to run ${value}`);
  return `${envValue}${match[2]}`;
}

function endpointHealthUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/$/, "")}/models`;
}

function preflightRun(run) {
  const baseUrl = executionValue(run.baseUrl);
  const apiKey = executionValue(run.apiKey);
  const args = ["-fsS", "--max-time", "5", endpointHealthUrl(baseUrl)];
  if (apiKey && apiKey !== "local" && apiKey !== "fusion") {
    args.splice(1, 0, "-H", `Authorization: Bearer ${apiKey}`);
  }
  const result = spawnSync("curl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    label: run.label,
    model: run.model,
    base_url: baseUrl,
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr.trim(),
  };
}

function preflightMatrix(runs) {
  const checks = runs.map(preflightRun);
  const failed = checks.filter((check) => !check.ok);
  console.log(
    JSON.stringify(
      {
        schema_version: "understudy.automationbench_matrix_preflight.v1",
        ok: failed.length === 0,
        checks,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) {
    throw new Error(`preflight failed for ${failed.map((check) => check.label).join(", ")}`);
  }
}

function autoBenchArgs(handoff, run, outDir, config, options = {}) {
  const baseUrl = options.execution ? executionValue(run.baseUrl) : run.baseUrl;
  const apiKey = options.execution ? executionValue(run.apiKey) : run.apiKey;
  const values = [
    "run",
    "auto-bench",
    "--model",
    run.model,
    "--base-url",
    baseUrl,
    "--api-key",
    apiKey,
    "--domains",
    config.domains,
  ];
  if (config.numExamples !== null) {
    values.push("--num-examples", config.numExamples);
  }
  values.push(
    "--max-concurrent",
    config.maxConcurrent,
    "--max-steps",
    config.maxSteps,
    "--toolset",
    "api",
    "--export-json",
    outputPath(outDir, handoff, run, config),
    "--save-every",
    config.saveEvery,
  );
  return values;
}

function ingestArgs(handoffPath, handoff, run, outDir, eventLog, args, config) {
  const values = [
    "scripts/automationbench-handoff-runner.mjs",
    "--handoff",
    handoffPath,
    "--results",
    outputPath(outDir, handoff, run, config),
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

function printDryRun({ handoffPath, handoff, runs, benchDir, outDir, eventLog, args, config }) {
  console.log(`# AutomationBench Fusion matrix: ${handoff.run_id}`);
  console.log(`# bench_dir=${benchDir}`);
  console.log(`# domains=${config.domains}`);
  console.log(`# num_examples=${config.numExamples ?? "full"}`);
  console.log(`# outputs=${outDir}`);
  console.log(`# event_log=${eventLog}`);
  const needsProxy = runs.some((run) => run.baseUrl === DEFAULT_PROXY_BASE_URL || run.fusionEventLog);
  if (needsProxy) {
    console.log(`# Start proxy first: FUSION_PROXY_EVENT_LOG=${shellQuote(eventLog)} node scripts/automationbench-fusion-proxy.mjs --port 17890`);
  }
  for (const run of runs) {
    console.log("");
    console.log(`# ${run.label}`);
    console.log(`cd ${shellQuote(benchDir)} && ${commandString("uv", autoBenchArgs(handoff, run, outDir, config))}`);
    console.log(commandString("node", ingestArgs(handoffPath, handoff, run, outDir, eventLog, args, config)));
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

function summarizeRows(rows) {
  const byRoute = new Map();
  for (const row of rows) {
    const mode = row.mode ?? "unknown";
    const model = row.model ?? "unknown";
    const key = `${mode}\u0000${model}`;
    const current = byRoute.get(key) ?? {
      mode,
      model,
      rows: 0,
      passed: 0,
      gateway_rows: 0,
      elapsed_ms: 0,
      tokens: 0,
      sidekick_runs: 0,
    };
    current.rows += 1;
    current.passed += row.status === "ok" ? 1 : 0;
    current.gateway_rows += row.gateway_used ? 1 : 0;
    current.elapsed_ms += Number(row.elapsed_ms ?? 0);
    current.tokens += Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0);
    current.sidekick_runs += Number(row.sidekick_runs ?? 0);
    byRoute.set(key, current);
  }
  return [...byRoute.values()].map((summary) => ({
    mode: summary.mode,
    model: summary.model,
    rows: summary.rows,
    passed: summary.passed,
    pass_rate: summary.rows ? summary.passed / summary.rows : 0,
    gateway_rows: summary.gateway_rows,
    sidekick_runs: summary.sidekick_runs,
    avg_elapsed_ms: summary.rows ? Math.round(summary.elapsed_ms / summary.rows) : null,
    avg_tokens: summary.rows ? Math.round(summary.tokens / summary.rows) : null,
  }));
}

function runMatrix({ handoff, runs, benchDir, outDir, config }) {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(benchDir)) throw new Error(`AutomationBench directory not found: ${benchDir}`);
  for (const run of runs) {
    console.error(`running ${run.label}`);
    runCommand("uv", autoBenchArgs(handoff, run, outDir, config, { execution: true }), { cwd: benchDir });
  }
}

function ingestMatrix({ handoffPath, handoff, runs, outDir, eventLog, args, config }) {
  const rows = [];
  for (const run of runs) {
    const path = outputPath(outDir, handoff, run, config);
    if (!existsSync(path)) throw new Error(`missing result export for ${run.label}: ${path}`);
    console.error(`ingesting ${run.label}`);
    const result = runCommand("node", ingestArgs(handoffPath, handoff, run, outDir, eventLog, args, config), {
      capture: true,
    });
    const parsed = JSON.parse(result.stdout);
    rows.push(...(parsed.rows ?? []));
  }
  console.log(
    JSON.stringify(
      {
        schema_version: "understudy.automationbench_matrix_results.v1",
        handoff_run_id: handoff.run_id,
        domains: config.domains,
        num_examples: config.numExamples ?? "full",
        rows,
        summary: summarizeRows(rows),
      },
      null,
      2,
    ),
  );
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
  const config = runConfig(handoff, args);
  if (args.includes("--preflight")) {
    preflightMatrix(runs);
    return;
  }
  if (args.includes("--dry-run") || (!args.includes("--run") && !args.includes("--ingest"))) {
    printDryRun({ handoffPath, handoff, runs, benchDir, outDir, eventLog, args, config });
    return;
  }
  if (args.includes("--run")) runMatrix({ handoff, runs, benchDir, outDir, config });
  if (args.includes("--ingest")) ingestMatrix({ handoffPath, handoff, runs, outDir, eventLog, args, config });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
