#!/usr/bin/env node
/**
 * rigor-ci.mjs — CI entry point for the token-free benchmark rigor gate.
 *
 * Runs the same checks as `understudy benchmarks rigor --ci` (dist must be
 * built first: `npm run build`) over the given benchmark dirs, defaulting to
 * the experiments/benchmark-hub-demo fixture benchmarks. Exit 1 on any hard
 * FAIL; UNKNOWN (missing evidence) is reported honestly and is fatal only
 * with --strict. --changed-only limits the run to dirs touched since the
 * merge-base with origin/main.
 *
 * Usage: node scripts/rigor-ci.mjs [--strict] [--changed-only] [dir ...]
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distModule = join(repoRoot, "dist", "rigor-report.js");
if (!existsSync(distModule)) {
  console.error("rigor-ci: dist/rigor-report.js not found — run `npm run build` first");
  process.exit(1);
}
const { filterChangedBenchmarkDirs, renderRigorCiLines, rigorCiExitCode, runRigorCiChecks } = await import(distModule);

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const changedOnly = args.includes("--changed-only");
const DEFAULT_FIXTURES = [
  "experiments/benchmark-hub-demo/acme-coding-agent-bench",
  "experiments/benchmark-hub-demo/automationbench-import",
  "experiments/benchmark-hub-demo/event-categorizer-starter",
];
let dirs = args.filter((arg) => !arg.startsWith("--"));
if (dirs.length === 0) dirs = DEFAULT_FIXTURES.map((dir) => join(repoRoot, dir));

if (changedOnly) {
  const { dirs: changed, base } = filterChangedBenchmarkDirs(dirs);
  console.error(base === null ? "rigor-ci: git base unavailable — checking every dir" : `rigor-ci: ${changed.length}/${dirs.length} dir(s) changed since ${base}`);
  dirs = changed;
  if (dirs.length === 0) {
    console.log("[]");
    process.exit(0);
  }
}

const reports = dirs.map((dir) => runRigorCiChecks(dir));
for (const report of reports) for (const line of renderRigorCiLines(report)) console.error(line);
console.log(JSON.stringify(reports, null, 2));

const code = rigorCiExitCode(reports, { strict });
if (code !== 0) console.error(`rigor-ci: FAIL${strict ? " (strict: UNKNOWN is fatal)" : ""}`);
else console.error(`rigor-ci: PASS (${reports.length} benchmark dir(s); ${reports.reduce((n, r) => n + r.unknowns.length, 0)} UNKNOWN line(s) reported, non-fatal)`);
process.exit(code);
