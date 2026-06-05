#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { validatePublicText } from "./public-safety.mjs";

const cookbookRoot = "cookbook";
const requiredExamples = [
  "capture-evidence-node",
  "optimize-eval-input-gepa",
  "gateway-openai-typescript",
];
const uvAvailable = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

function runCli(args, options = {}) {
  const result = spawnSync("node", ["dist/bin.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runNpmTest(cwd) {
  const result = spawnSync("npm", ["test"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function copyCookbook(name) {
  const source = join(cookbookRoot, name);
  const destination = mkdtempSync(join(tmpdir(), `understudy-cookbook-${name}-`));
  cpSync(source, destination, { recursive: true });
  return destination;
}

function hashJson(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCaptureEvidenceArtifacts(repo) {
  const dir = join(repo, ".understudy", "capture-evidence");
  mkdirSync(dir, { recursive: true });
  const harness = {
    schema_version: "understudy.harness.v1",
    command: "npm test",
    entrypoint: "src/agent.ts",
    mode: "local-only",
  };
  const environment = {
    schema_version: "understudy.environment.v1",
    runtime: "node",
    provider_keys_required: false,
    network_required: false,
  };
  const metric = {
    schema_version: "understudy.metric.v1",
    approved: true,
    primary_metric: "exact_match",
    validator: { kind: "deterministic", proxy_only: false },
    feedback: { required: true, source: "local fixture labels" },
  };
  const splits = {
    schema_version: "understudy.splits.v1",
    train: ["train-1"],
    dev: ["dev-1"],
    holdout: ["holdout-1"],
    holdout_policy: "reserved-for-final-validation",
  };
  const baseline = {
    schema_version: "understudy.baseline.v1",
    candidate: "incumbent",
    score: 0.5,
    harness_sha256: hashJson(harness),
    metric_sha256: hashJson(metric),
    splits_sha256: hashJson(splits),
  };
  writeJson(join(dir, "harness.json"), harness);
  writeJson(join(dir, "environment.json"), environment);
  writeJson(join(dir, "metric.json"), metric);
  writeJson(join(dir, "splits.json"), splits);
  writeJson(join(dir, "baseline.json"), baseline);
}

function validateTextTree(root) {
  const errors = [];
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    errors.push(...validatePublicText(join(entry.parentPath ?? root, entry.name)));
  }
  return errors;
}

const errors = [];
for (const example of requiredExamples) {
  const path = join(cookbookRoot, example);
  if (!existsSync(path)) {
    errors.push(`${path}: missing cookbook example`);
  }
}
errors.push(...validateTextTree(cookbookRoot));
if (errors.length > 0) {
  for (const error of errors) {
    console.log(error);
  }
  process.exit(1);
}

runNpmTest(join(cookbookRoot, "capture-evidence-node"));
runNpmTest(join(cookbookRoot, "gateway-openai-typescript"));

const captureRepo = copyCookbook("capture-evidence-node");
try {
  const result = runCli(["capture-evidence", "check", "--repo", captureRepo]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.artifacts.check, ".understudy/capture-evidence/check.json");
  assert.equal(payload.mode, "local-only");
  writeCaptureEvidenceArtifacts(captureRepo);
  runCli(["optimize-workload", "check", "--repo", captureRepo]);
} finally {
  rmSync(captureRepo, { recursive: true, force: true });
}

if (uvAvailable) {
  const optimizeRepo = copyCookbook("optimize-eval-input-gepa");
  try {
    writeCaptureEvidenceArtifacts(optimizeRepo);
    runCli(["optimize-workload", "check", "--repo", optimizeRepo]);
    const manifest = join(optimizeRepo, "eval-input-manifest.json");
    const result = runCli([
      "optimize-workload",
      "adapter",
      "run",
      "--repo",
      optimizeRepo,
      "--adapter",
      "eval-input-gepa",
      "--manifest",
      manifest,
      "--max-metric-calls",
      "2",
      "--execute",
    ]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, "understudy.eval_input_gepa_adapter.v1");
    assert.equal(payload.provider_calls, false);
    assert.equal(payload.holdout_count_excluded, 1);
    const proof = JSON.parse(readFileSync(join(optimizeRepo, ".understudy", "optimize-workload", "proof-packet.json"), "utf8"));
    assert.equal(proof.holdout_accessed_during_optimization, false);
  } finally {
    rmSync(optimizeRepo, { recursive: true, force: true });
  }
} else {
  const optimizeRepo = copyCookbook("optimize-eval-input-gepa");
  try {
    writeCaptureEvidenceArtifacts(optimizeRepo);
    runCli(["optimize-workload", "check", "--repo", optimizeRepo]);
    const manifest = join(optimizeRepo, "eval-input-manifest.json");
    const result = runCli([
      "optimize-workload",
      "adapter",
      "run",
      "--repo",
      optimizeRepo,
      "--adapter",
      "eval-input-gepa",
      "--manifest",
      manifest,
    ]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, "understudy.eval_input_gepa_adapter.v1");
    assert.equal(payload.status, "blocked");
    assert.equal(payload.optimizer_execution, false);
  } finally {
    rmSync(optimizeRepo, { recursive: true, force: true });
  }
}

console.log(`ok cookbook examples${uvAvailable ? "" : " (uv execution skipped)"}`);
