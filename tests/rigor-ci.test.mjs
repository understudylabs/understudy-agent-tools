import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { filterChangedBenchmarkDirs, renderRigorCiLines, rigorCiExitCode, runRigorCiChecks } from "../dist/rigor-report.js";
import { promoteTraceBenchmark } from "../dist/trace-foundry.js";

const FIXTURE = resolve("experiments/benchmark-hub-demo/acme-coding-agent-bench");

/** Minimal valid understudy.benchmark.v1 manifest with two tasks. */
const validManifest = () => ({
  schema_version: "understudy.benchmark.v1",
  benchmark_id: "rigor-ci-fixture",
  name: "Rigor CI fixture",
  description: "test",
  created_at: "2026-07-23T00:00:00Z",
  provenance: { origin: "derived-from-traces", source_refs: [] },
  taxonomy: [{ category_id: "cat-a", name: "A" }],
  tasks: [
    { task_id: "t-1", category_id: "cat-a", genesis: "replayed", split: "train", gold: null },
    { task_id: "t-2", category_id: "cat-a", genesis: "replayed", split: "holdout", gold: null },
  ],
  environment: { format: "verifiers.v1", package_ref: "environment", package_sha256: null, tool_surface: [], runtime: "subprocess" },
  verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "partial", replayable: true },
  splits: { boundary: "test", splits_sha256: "0".repeat(64), contamination: "clean" },
  linked_eval: null,
  results_contract: { row_schema: "understudy.eval_result.v1", trace_artifact: "traces.jsonl", branch_projection: "one_eval_row_per_root_to_leaf_branch" },
});

const row = (over) => ({
  schema_version: "understudy.eval_result.v1",
  run_id: "r-1",
  task_id: "t-1",
  split: "train",
  score: 1,
  subscores: {},
  status: "ok",
  model: "m",
  created_at: "2026-07-23T00:00:00Z",
  ...over,
});

function makeDir({ manifest = validManifest(), rows = [], calibration = null, versions = null, foundryManifest = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rigor-ci-"));
  writeFileSync(join(dir, "benchmark.json"), JSON.stringify(manifest));
  if (rows.length > 0) writeFileSync(join(dir, "rows-test.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (calibration !== null) writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibration));
  if (versions !== null) writeFileSync(join(dir, "versions.jsonl"), versions.map((v) => JSON.stringify(v)).join("\n") + "\n");
  if (foundryManifest !== null) writeFileSync(join(dir, "manifest.json"), JSON.stringify(foundryManifest));
  return dir;
}

const check = (report, name) => report.checks.find((c) => c.check === name);

describe("runRigorCiChecks", () => {
  it("reports honest UNKNOWNs (no fabricated passes) on a minimal valid dir", () => {
    const report = runRigorCiChecks(makeDir());
    assert.equal(check(report, "manifest-schema").status, "PASS");
    assert.equal(check(report, "contamination").status, "PASS"); // manifest splits say clean
    for (const name of ["oracle-solvability", "trivial-floors", "reward-hack-sentinels", "gold-leakage"]) {
      assert.equal(check(report, name).status, "UNKNOWN");
    }
    assert.deepEqual(report.failures, []);
    assert.equal(report.schema_version, "understudy.rigor_ci.v1");
  });

  it("FAILs manifest-schema on a missing or invalid benchmark.json", () => {
    const missing = runRigorCiChecks(mkdtempSync(join(tmpdir(), "rigor-ci-empty-")));
    assert.equal(check(missing, "manifest-schema").status, "FAIL");
    const invalid = runRigorCiChecks(makeDir({ manifest: { schema_version: "nope" } }));
    assert.equal(check(invalid, "manifest-schema").status, "FAIL");
    assert.ok(invalid.failures.includes("manifest-schema"));
  });

  it("PASSes oracle-solvability only when every recorded oracle score is 1.0", () => {
    const pass = runRigorCiChecks(makeDir({ rows: [row({ subscores: { runner_oracle: 1 }, score: 1 })] }));
    assert.equal(check(pass, "oracle-solvability").status, "PASS");
    const fail = runRigorCiChecks(makeDir({ rows: [row({ subscores: { runner_oracle: 1 }, score: 0.5, task_id: "t-2" })] }));
    assert.equal(check(fail, "oracle-solvability").status, "FAIL");
    assert.match(check(fail, "oracle-solvability").detail, /t-2/);
  });

  it("checks null/spam floors only where calibration.json exists, at <= 5%", () => {
    const noCal = runRigorCiChecks(makeDir({ rows: [row({ arm_kind: "null_agent", score: 1 })] }));
    assert.equal(check(noCal, "trivial-floors").status, "UNKNOWN");
    const failing = runRigorCiChecks(
      makeDir({ calibration: { threshold: 1 }, rows: [row({ arm_kind: "null_agent", score: 1 }), row({ arm_kind: "null_agent", task_id: "t-2", score: 1 })] }),
    );
    assert.equal(check(failing, "trivial-floors").status, "FAIL"); // 100% floor
    const passing = runRigorCiChecks(
      makeDir({ calibration: { threshold: 1 }, rows: [row({ arm_kind: "null_agent", score: 0 }), row({ arm_kind: "spam_agent", task_id: "t-2", score: 0 })] }),
    );
    assert.equal(check(passing, "trivial-floors").status, "PASS");
  });

  it("FAILs when reward-hack sentinel rows pass the threshold", () => {
    const report = runRigorCiChecks(makeDir({ rows: [row({ arm_kind: "reward_hack", score: 1 })] }));
    assert.equal(check(report, "reward-hack-sentinels").status, "FAIL");
    const clean = runRigorCiChecks(makeDir({ rows: [row({ arm_kind: "reward_hack", score: 0 })] }));
    assert.equal(check(clean, "reward-hack-sentinels").status, "PASS");
  });

  it("FAILs on verbatim (tier-1) gold-leakage findings, advisory-only fuzzy passes", () => {
    const audit = (findings) => ({ leakage_audit: { schema_version: "understudy.leakage_audit.v1", checked_tasks: 2, findings } });
    const fail = runRigorCiChecks(makeDir({ foundryManifest: audit([{ tier: "verbatim", task_id: "t-1" }]) }));
    assert.equal(check(fail, "gold-leakage").status, "FAIL");
    const pass = runRigorCiChecks(makeDir({ foundryManifest: audit([{ tier: "fuzzy", task_id: "t-1" }]) }));
    assert.equal(check(pass, "gold-leakage").status, "PASS");
  });

  it("takes contamination from the newest versions.jsonl line, FAILing on contaminated", () => {
    const report = runRigorCiChecks(
      makeDir({ versions: [{ created_at: "a", contamination: "clean" }, { created_at: "b", contamination: "contaminated" }] }),
    );
    assert.equal(check(report, "contamination").status, "FAIL");
    assert.ok(report.failures.includes("contamination"));
  });

  it("passes non-strict and reports UNKNOWNs on the demo fixture benchmark", () => {
    const report = runRigorCiChecks(FIXTURE);
    assert.deepEqual(report.failures, []);
    assert.ok(report.unknowns.length > 0); // honest gaps, never silent
    assert.equal(check(report, "contamination").status, "PASS");
  });

  it("the strict CI gate fixture keeps ALL six checks provably PASS (no UNKNOWN can hide a regression)", () => {
    // CI runs `rigor-ci.mjs --strict` over this dir; if any check here decays
    // to UNKNOWN, four of the six checks silently lose their ability to fail.
    const report = runRigorCiChecks(resolve("tests/fixtures/rigor-gate-bench"));
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.unknowns, []);
    assert.equal(report.checks.length, 6);
    for (const c of report.checks) assert.equal(c.status, "PASS", `${c.check}: ${c.detail}`);
    assert.equal(rigorCiExitCode([report], { strict: true }), 0);
  });
});

describe("rigorCiExitCode", () => {
  it("is 0 on UNKNOWN-only by default, 1 under strict, 1 on any FAIL", () => {
    const unknownOnly = runRigorCiChecks(makeDir());
    assert.equal(rigorCiExitCode([unknownOnly]), 0);
    assert.equal(rigorCiExitCode([unknownOnly], { strict: true }), 1);
    const failed = runRigorCiChecks(makeDir({ versions: [{ created_at: "a", contamination: "contaminated" }] }));
    assert.equal(rigorCiExitCode([unknownOnly, failed]), 1);
  });
});

describe("renderRigorCiLines", () => {
  it("renders one status line per check", () => {
    const report = runRigorCiChecks(makeDir());
    const lines = renderRigorCiLines(report);
    assert.equal(lines.length, report.checks.length + 1);
    assert.match(lines[1], /^ {2}\[(PASS|FAIL|UNKNOWN)\] /);
  });
});

describe("filterChangedBenchmarkDirs", () => {
  /** Temp git repo: bench-a touched in the newest commit, bench-b untouched. */
  function makeRepo() {
    // realpath: on macOS tmpdir is a symlink; git reports physical paths.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rigor-changed-")));
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    for (const bench of ["bench-a", "bench-b"]) {
      mkdirSync(join(repo, "benchmarks", bench), { recursive: true });
      writeFileSync(join(repo, "benchmarks", bench, "tasks.jsonl"), JSON.stringify({ task_id: "t-1" }) + "\n");
    }
    mkdirSync(join(repo, "apps", "sub"), { recursive: true });
    writeFileSync(join(repo, "apps", "sub", "keep"), "");
    git("add", "-A");
    git("commit", "-qm", "base");
    writeFileSync(join(repo, "benchmarks", "bench-a", "tasks.jsonl"), JSON.stringify({ task_id: "t-1", changed: true }) + "\n");
    git("add", "-A");
    git("commit", "-qm", "touch bench-a");
    return repo;
  }

  /** Run fn with process.cwd() moved to `dir` (the function shells out to git from cwd). */
  function withCwd(dir, fn) {
    const previous = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(previous);
    }
  }

  it("keeps exactly the dirs touched since the base ref", () => {
    const repo = makeRepo();
    const dirs = [join(repo, "benchmarks", "bench-a"), join(repo, "benchmarks", "bench-b")];
    const { dirs: changed, base } = withCwd(repo, () => filterChangedBenchmarkDirs(dirs, "HEAD~1"));
    assert.equal(base, "HEAD~1");
    assert.deepEqual(changed, [join(repo, "benchmarks", "bench-a")]);
  });

  it("resolves git's repo-root-relative paths correctly from a subdirectory cwd", () => {
    // Regression: resolving `git diff --name-only` output against process.cwd()
    // from a subdirectory matched nothing and silently skipped every changed
    // dir — a green gate that checked nothing.
    const repo = makeRepo();
    const sub = join(repo, "apps", "sub");
    const dirs = [join(repo, "benchmarks", "bench-a"), join(repo, "benchmarks", "bench-b")];
    const { dirs: changed } = withCwd(sub, () => filterChangedBenchmarkDirs(dirs, "HEAD~1"));
    assert.deepEqual(changed, [join(repo, "benchmarks", "bench-a")]);
    // Relative dir args resolve against cwd, exactly like the CLI receives them.
    const relative = withCwd(sub, () =>
      filterChangedBenchmarkDirs([join("..", "..", "benchmarks", "bench-a"), join("..", "..", "benchmarks", "bench-b")], "HEAD~1"),
    );
    assert.deepEqual(relative.dirs, [join("..", "..", "benchmarks", "bench-a")]);
  });

  it("falls back to every dir (honest over-checking) when git fails", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "rigor-nogit-")));
    const dirs = [join(outside, "bench-a")];
    const result = withCwd(outside, () => filterChangedBenchmarkDirs(dirs, "HEAD~1"));
    assert.deepEqual(result, { dirs, base: null });
  });
});

describe("pre-promote rigor gate (promoteTraceBenchmark)", () => {
  it("refuses promotion on hard rigor failures without an override reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "rigor-promote-"));
    writeFileSync(join(dir, "tasks.jsonl"), JSON.stringify({ task_id: "t-1" }) + "\n");
    assert.throws(
      () => promoteTraceBenchmark(dir, { rigorGate: { failures: ["contamination"], unknowns: [] } }),
      /Pre-promote rigor gate FAILED \(contamination\)/,
    );
  });

  it("records the override in promotion-record.json when forced past failures", async () => {
    const fs = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "rigor-promote-ok-"));
    writeFileSync(join(dir, "tasks.jsonl"), JSON.stringify({ task_id: "t-1", title: "t", tool_surface: [], split: "construction", task_hash: "abcd1234", source: { node_ids: [] }, outcome_contract: { required: [] } }) + "\n");
    writeFileSync(join(dir, "review-decisions.jsonl"), JSON.stringify({ task_id: "t-1", decision: "accept" }) + "\n");
    mkdirSync(join(dir, "environment"), { recursive: true });
    writeFileSync(join(dir, "environment", "offline-validation.json"), JSON.stringify({ tasks: [{ task_id: "t-1", oracle: { score: 1 }, sentinels: {} }] }));
    const result = promoteTraceBenchmark(dir, { rigorGate: { failures: ["gold-leakage"], unknowns: ["trivial-floors"], overrideReason: "demo override" } });
    assert.equal(result.schema_version, "understudy.promotion_result.v1");
    const record = JSON.parse(fs.readFileSync(join(dir, "promotion-record.json"), "utf8"));
    assert.equal(record.rigor_gate.status, "overridden");
    assert.equal(record.rigor_gate.override_reason, "demo override");
    assert.deepEqual(record.rigor_gate.failures, ["gold-leakage"]);
  });

  it("records a passed gate when there are no failures", async () => {
    const fs = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "rigor-promote-pass-"));
    writeFileSync(join(dir, "tasks.jsonl"), JSON.stringify({ task_id: "t-1", title: "t", tool_surface: [], split: "construction", task_hash: "abcd1234", source: { node_ids: [] }, outcome_contract: { required: [] } }) + "\n");
    writeFileSync(join(dir, "review-decisions.jsonl"), JSON.stringify({ task_id: "t-1", decision: "accept" }) + "\n");
    mkdirSync(join(dir, "environment"), { recursive: true });
    writeFileSync(join(dir, "environment", "offline-validation.json"), JSON.stringify({ tasks: [{ task_id: "t-1", oracle: { score: 1 }, sentinels: {} }] }));
    const result = promoteTraceBenchmark(dir, { rigorGate: { failures: [], unknowns: ["gold-leakage"] } });
    assert.equal(result.promoted, 1);
    const record = JSON.parse(fs.readFileSync(join(dir, "promotion-record.json"), "utf8"));
    assert.equal(record.rigor_gate.status, "passed");
  });
});
