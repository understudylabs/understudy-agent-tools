#!/usr/bin/env node

// Experiment notes, receipts, and reproduction commands: ./README.md

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePool } from "./harness.mjs";
import { fireworksCallModel } from "./fireworks-client.mjs";
import { nemotronCallModel } from "./nemotron-text-tools.mjs";

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference";

function parseArgs(argv) {
  const options = {
    concurrency: 4,
    maxTokens: 1024,
    baseUrl: DEFAULT_BASE_URL,
    label: "",
    protocol: "nemotron-text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    index += 1;
    if (name === "concurrency" || name === "max-tokens") options[name === "max-tokens" ? "maxTokens" : name] = Number(value);
    else if (name === "model") options.model = value;
    else if (name === "split") options.split = value;
    else if (name === "out") options.out = value;
    else if (name === "label") options.label = value;
    else if (name === "frozen-holdout-sha256") options.frozenHoldoutSha256 = value;
    else if (name === "base-url") options.baseUrl = value;
    else if (name === "protocol") options.protocol = value;
    else throw new Error(`unknown argument: --${name}`);
  }
  if (!options.model || !options.split || !options.out) {
    throw new Error("--model, --split, and --out are required");
  }
  if (!["train", "dev", "holdout"].includes(options.split)) throw new Error("--split must be train, dev, or holdout");
  if (!["native", "nemotron-text"].includes(options.protocol)) throw new Error("--protocol must be native or nemotron-text");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) throw new Error("--max-tokens must be a positive integer");
  return options;
}

function assertOutputPath(outputPath) {
  const root = resolve("outputs");
  const target = resolve(outputPath);
  const suffix = relative(root, target);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${requireSeparator()}`)) {
    throw new Error("--out must be under outputs/");
  }
  return target;
}

function requireSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
}

function latencyStats(receipts) {
  const values = receipts.map((receipt) => receipt.latency_ms).filter((value) => Number.isFinite(value));
  return {
    calls: values.length,
    mean_ms: values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
  };
}

export async function runEval(options = parseArgs(process.argv.slice(2))) {
  const outputPath = assertOutputPath(options.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  const callModelFactory = options.protocol === "nemotron-text" ? nemotronCallModel : fireworksCallModel;
  const callModel = callModelFactory({
    model: options.model,
    baseUrl: options.baseUrl,
    maxTokens: options.maxTokens,
  });
  const started = performance.now();
  const evaluated = await evaluatePool({
    split: options.split,
    frozenHoldoutSha256: options.frozenHoldoutSha256,
    callModel,
    concurrency: options.concurrency,
  });
  const wallTimeMs = Math.round(performance.now() - started);
  const taskSummaries = evaluated.results.map((result) => ({
    task_id: result.taskId,
    score: result.reward,
    steps: result.steps,
    malformed: result.malformed,
    forbidden_effects: result.forbiddenEffects,
  }));
  const artifact = {
    label: options.label,
    model: options.model,
    split: options.split,
    timestamp: new Date().toISOString(),
    protocol: options.protocol,
    mean_score: evaluated.meanScore,
    by_band: evaluated.byBand,
    rows: evaluated.rows,
    tasks: taskSummaries,
    usage: { ...callModel.usage },
    latency: { ...latencyStats(callModel.receipts), total_wall_time_ms: wallTimeMs },
    truncations: callModel.truncations ?? 0,
    malformed_task_count: evaluated.results.filter((result) => result.malformed > 0).length,
    error_count: evaluated.rows.filter((row) => row.status === "error").length,
  };
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(
    `${outputPath}.transcripts.jsonl`,
    `${evaluated.results.map((result) => JSON.stringify({
      task_id: result.taskId,
      score: result.reward,
      transcript: result.transcript,
    })).join("\n")}\n`,
  );
  process.stdout.write(
    `${options.label || options.split} model=${options.model} split=${options.split} `
    + `tasks=${evaluated.rows.length} mean_score=${evaluated.meanScore.toFixed(4)} `
    + `errors=${artifact.error_count} malformed_tasks=${artifact.malformed_task_count}\n`,
  );
  return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEval().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
