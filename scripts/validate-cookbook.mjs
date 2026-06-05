#!/usr/bin/env node

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

function copyCookbook(name) {
  const source = join(cookbookRoot, name);
  const destination = mkdtempSync(join(tmpdir(), `understudy-cookbook-${name}-`));
  cpSync(source, destination, { recursive: true });
  return destination;
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

const captureRepo = copyCookbook("capture-evidence-node");
try {
  const result = runCli(["capture-evidence", "check", "--repo", captureRepo]);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.artifacts.check, ".understudy/capture-evidence/check.json");
  assert.equal(payload.mode, "local-only");
} finally {
  rmSync(captureRepo, { recursive: true, force: true });
}

const optimizeRepo = copyCookbook("optimize-eval-input-gepa");
try {
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

console.log("ok cookbook examples");
