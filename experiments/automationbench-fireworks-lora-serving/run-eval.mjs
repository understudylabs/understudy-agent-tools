#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePool } from "./harness.mjs";
import { fireworksCallModel } from "./fireworks-client.mjs";
import { jsonTextCallModel } from "./json-text-tools.mjs";
import { nemotronCallModel } from "./nemotron-text-tools.mjs";

const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference";
const HOLDOUT_SHA256 = "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701";

export function parseArgs(argv) {
  const options = {
    concurrency: 4,
    maxTokens: 1024,
    baseUrl: DEFAULT_BASE_URL,
    label: "",
    protocol: "native",
    temperature: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    index += 1;
    if (name === "concurrency") options.concurrency = Number(value);
    else if (name === "max-tokens") options.maxTokens = Number(value);
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
  if (!["train", "dev", "holdout"].includes(options.split)) {
    throw new Error("--split must be train, dev, or holdout");
  }
  if (!["native", "nemotron-text", "json-text"].includes(options.protocol)) {
    throw new Error("--protocol must be native, nemotron-text, or json-text");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
    throw new Error("--max-tokens must be a positive integer");
  }
  if (options.split === "holdout" && options.frozenHoldoutSha256 !== HOLDOUT_SHA256) {
    throw new Error(`holdout requires --frozen-holdout-sha256 ${HOLDOUT_SHA256}`);
  }
  return options;
}

function assertOutputPath(outputPath) {
  const root = resolve("outputs");
  const target = resolve(outputPath);
  const suffix = relative(root, target);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("--out must be under outputs/");
  }
  return target;
}

export async function runEval(options = parseArgs(process.argv.slice(2))) {
  const outputPath = assertOutputPath(options.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  const factory = options.protocol === "nemotron-text"
    ? nemotronCallModel
    : options.protocol === "json-text"
      ? jsonTextCallModel
      : fireworksCallModel;
  const callModel = factory({
    model: options.model,
    baseUrl: options.baseUrl,
    maxTokens: options.maxTokens,
    temperature: 0,
  });
  callModel.runId = options.label || `${options.split}-${Date.now()}`;
  const started = performance.now();
  const evaluated = await evaluatePool({
    split: options.split,
    frozenHoldoutSha256: options.frozenHoldoutSha256,
    callModel,
    concurrency: options.concurrency,
  });
  const artifact = {
    schema_version: "understudy.eval_result.v1",
    label: options.label,
    model: options.model,
    split: options.split,
    protocol: options.protocol,
    mean_score: evaluated.meanScore,
    rows: evaluated.rows,
    tasks: evaluated.results.map((result) => ({
      task_id: result.taskId,
      score: result.score,
      steps: result.steps,
      malformed: result.malformed,
      forbidden_effects: result.forbiddenEffects,
      ...(result.error ? { error: result.error } : {}),
    })),
    usage: { ...callModel.usage },
    elapsed_ms: Math.round(performance.now() - started),
    provenance: {
      split_sha256: evaluated.rows[0]?.provenance?.split_sha256 ?? null,
      harness_sha256: evaluated.rows[0]?.provenance?.harness_sha256 ?? null,
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(
    `${outputPath}.transcripts.jsonl`,
    `${evaluated.results.map((result) => JSON.stringify({
      task_id: result.taskId,
      score: result.score,
      transcript: result.transcript,
    })).join("\n")}\n`,
  );
  process.stdout.write(`${options.label || options.split} tasks=${evaluated.rows.length} mean_score=${evaluated.meanScore.toFixed(4)}\n`);
  return artifact;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEval().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
