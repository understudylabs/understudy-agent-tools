#!/usr/bin/env node
/**
 * Preflight for `next dev`/`next build`: lib/data-core.ts (and friends)
 * import the ROOT repo's compiled dist/*.js — in a clean worktree those
 * files don't exist yet and every page 500s with an opaque module-not-found.
 * Fail fast with the fix instead.
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const required = [
  "benchmark-artifacts.js",
  "benchmark-hub-core.js",
  "benchmark-hub-types.js",
  "benchmark-replay.js",
  "benchmark.js",
  "bootstrap-ci.js",
  "partner-report.js",
  "run-executor.js",
  "trace-author.js",
].map((f) => resolve(repoRoot, "dist", f));
const missing = required.filter((f) => !existsSync(f));

if (missing.length > 0) {
  console.error("benchmark-hub preflight: the repo-root CLI build is missing:");
  for (const f of missing) console.error(`  - ${f}`);
  console.error("\nThe hub imports these compiled modules (lib/data-core.ts → ../../../dist/*.js).");
  console.error("Fix: run `npm run build` at the repo root first, then retry.");
  process.exit(1);
}
