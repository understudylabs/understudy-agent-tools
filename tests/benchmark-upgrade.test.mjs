import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  isRowStale,
  latestBreakingBumps,
  planBenchmarkUpgrade,
  serializeVersionEntryLine,
  staleRowSummary,
} from "../dist/benchmark-upgrade.js";

const task = (id, over = {}) => ({
  task_id: id,
  category_id: "cat-a",
  genesis: "imported",
  split: "holdout",
  instruction: "do the thing",
  gold: { kind: "reference", ref: `gold/${id}.json` },
  ...over,
});

const manifest = (tasks, over = {}) => ({
  schema_version: "understudy.benchmark.v1",
  benchmark_id: "bench-upgrade",
  provenance: { origin: "authored" },
  taxonomy: [{ category_id: "cat-a" }],
  tasks,
  environment: { format: "verifiers.v1", package_ref: "pkg" },
  verifier: { kind: "reward-fns", strict_metric: "strict" },
  ...over,
});

describe("planBenchmarkUpgrade", () => {
  it("maps env/verifier/meta changes to rerun/regrade/reuse and bumps versions", () => {
    const oldM = manifest([task("t-env"), task("t-ver"), task("t-meta"), task("t-same"), task("t-gone")]);
    const newM = manifest([
      task("t-env", { instruction: "do the NEW thing" }),
      task("t-ver", { gold: { kind: "reference", ref: "gold/changed.json" } }),
      task("t-meta", { title: "renamed" }),
      task("t-same"),
      task("t-new"),
    ]);
    const plan = planBenchmarkUpgrade(oldM, newM, { previousBenchmarkVersion: "2.3.4", now: "2026-07-23T00:00:00Z" });

    assert.deepEqual(plan.diff.plan.rerun.sort(), ["t-env", "t-new"]);
    assert.deepEqual(plan.diff.plan.regrade, ["t-ver"]);
    assert.deepEqual(plan.diff.plan.reuse.sort(), ["t-meta", "t-same"]);
    assert.deepEqual(plan.diff.removed, ["t-gone"]);
    assert.equal(plan.benchmark_version.from, "2.3.4");
    assert.equal(plan.benchmark_version.to, "3.0.0"); // env change + added task => MAJOR
    assert.equal(plan.benchmark_version.bump, "major");
    assert.deepEqual(plan.counts, { rerun: 2, regrade: 1, reuse: 2, removed: 1 });
    assert.match(plan.cost_note, /rerun 2 task\(s\)/);
    assert.match(plan.cost_note, /regrade 1/);
    assert.match(plan.cost_note, /reuse 2/);
    assert.match(plan.cost_note, /1 removed/);

    // Entry shape: understudy.benchmark_version.v1 with per-task bumps.
    const e = plan.entry;
    assert.equal(e.schema_version, "understudy.benchmark_version.v1");
    assert.equal(e.created_at, "2026-07-23T00:00:00Z");
    assert.equal(e.version, "3.0.0");
    const byId = Object.fromEntries(e.task_bumps.map((b) => [b.task_id, b]));
    assert.deepEqual(byId["t-env"], { task_id: "t-env", bump: "major", from: "1.0.0", to: "2.0.0", reason: "env group changed (rerun)" });
    assert.deepEqual(byId["t-ver"], { task_id: "t-ver", bump: "minor", from: "1.0.0", to: "1.1.0", reason: "verifier group changed (regrade)" });
    assert.deepEqual(byId["t-meta"], { task_id: "t-meta", bump: "patch", from: "1.0.0", to: "1.0.1", reason: "meta group changed (reuse)" });
    assert.equal(byId["t-new"].from, null);
    assert.equal(byId["t-new"].bump, "major");
    assert.equal(byId["t-gone"].to, null);
    assert.equal(byId["t-gone"].bump, "minor");
    assert.equal(byId["t-same"], undefined); // no-op tasks record no bump
  });

  it("no changes => bump none, version unchanged, empty task_bumps", () => {
    const m = manifest([task("t1")]);
    const plan = planBenchmarkUpgrade(m, m, { previousBenchmarkVersion: "1.2.3" });
    assert.equal(plan.benchmark_version.to, "1.2.3");
    assert.equal(plan.benchmark_version.bump, "none");
    assert.deepEqual(plan.entry.task_bumps, []);
  });

  it("plans a regrade from stamped content_hashes alone (manifest tasks are references)", () => {
    // A tasks.jsonl gold/contract edit only shows up on the manifest task as a
    // re-stamped version + content_hashes — every surface field stays identical.
    const stamps = { env_sha256: "e".repeat(64), verifier_sha256: "v".repeat(64), meta_sha256: "m".repeat(64) };
    const oldM = manifest([task("t1", { version: "1.0.0", content_hashes: stamps })]);
    const newM = manifest([
      task("t1", { version: "1.1.0", content_hashes: { ...stamps, verifier_sha256: "w".repeat(64) } }),
    ]);
    const plan = planBenchmarkUpgrade(oldM, newM, { previousBenchmarkVersion: "1.0.0" });
    assert.deepEqual(plan.diff.plan.regrade, ["t1"]);
    assert.equal(plan.benchmark_version.to, "1.1.0");
    assert.deepEqual(plan.entry.task_bumps[0], {
      task_id: "t1",
      bump: "minor",
      from: "1.0.0",
      to: "1.1.0",
      reason: "verifier group changed (regrade)",
    });
  });

  it("identical stamped hashes diff to none even when review bookkeeping flipped", () => {
    const stamps = { env_sha256: "e".repeat(64), verifier_sha256: "v".repeat(64), meta_sha256: "m".repeat(64) };
    const oldM = manifest([task("t1", { status: "pending", content_hashes: stamps })]);
    const newM = manifest([task("t1", { status: "accepted", incumbent: { model: "m-2" }, content_hashes: stamps })]);
    const plan = planBenchmarkUpgrade(oldM, newM, { previousBenchmarkVersion: "1.0.0" });
    assert.equal(plan.benchmark_version.bump, "none");
    assert.deepEqual(plan.entry.task_bumps, []);
  });

  it("respects per-task version fields as bump baselines", () => {
    const oldM = manifest([task("t1", { version: "3.1.4" })]);
    const newM = manifest([task("t1", { version: "3.1.4", instruction: "changed" })]);
    const plan = planBenchmarkUpgrade(oldM, newM);
    assert.deepEqual(plan.entry.task_bumps[0].from, "3.1.4");
    assert.deepEqual(plan.entry.task_bumps[0].to, "4.0.0");
  });

  it("records the new manifest's splits contract on the entry", () => {
    const oldM = manifest([task("t1")]);
    const newM = manifest([task("t1", { title: "x" })], {
      splits: { boundary: "b", splits_sha256: "abc123", contamination: "clean" },
    });
    const plan = planBenchmarkUpgrade(oldM, newM);
    assert.equal(plan.entry.splits_sha256, "abc123");
    assert.equal(plan.entry.contamination, "clean");
  });

  it("serializeVersionEntryLine emits one parseable JSONL line", () => {
    const plan = planBenchmarkUpgrade(manifest([task("t1")]), manifest([task("t1", { instruction: "x" })]));
    const line = serializeVersionEntryLine(plan.entry);
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), plan.entry);
  });
});

describe("staleness math", () => {
  const versions = [
    { created_at: "2026-01-01T00:00:00Z", splits_sha256: null, contamination: null }, // legacy line: ignored
    {
      created_at: "2026-02-01T00:00:00Z",
      version: "2.0.0",
      task_bumps: [
        { task_id: "t-major", bump: "major", from: "1.0.0", to: "2.0.0" },
        { task_id: "t-patch", bump: "patch", from: "1.0.0", to: "1.0.1" },
      ],
    },
    {
      created_at: "2026-03-01T00:00:00Z",
      version: "2.1.0",
      task_bumps: [{ task_id: "t-minor", bump: "minor", from: "1.0.0", to: "1.1.0" }],
    },
  ];

  it("latestBreakingBumps keeps MAJOR/MINOR only, newest per task", () => {
    const bumps = latestBreakingBumps(versions);
    assert.deepEqual(Object.keys(bumps).sort(), ["t-major", "t-minor"]);
    assert.equal(bumps["t-major"].version, "2.0.0");
    assert.equal(bumps["t-minor"].created_at, "2026-03-01T00:00:00Z");
  });

  it("isRowStale: predating rows and missing created_at are stale; patch never stales", () => {
    const bumps = latestBreakingBumps(versions);
    assert.equal(isRowStale({ task_id: "t-major", created_at: "2026-01-15T00:00:00Z" }, bumps), true);
    assert.equal(isRowStale({ task_id: "t-major", created_at: "2026-02-02T00:00:00Z" }, bumps), false);
    assert.equal(isRowStale({ task_id: "t-major" }, bumps), true); // no provenance => conservative
    assert.equal(isRowStale({ task_id: "t-patch", created_at: "2020-01-01T00:00:00Z" }, bumps), false);
    assert.equal(isRowStale({ task_id: "t-unbumped", created_at: "2020-01-01T00:00:00Z" }, bumps), false);
  });

  it("staleRowSummary counts per task with the bumped version", () => {
    const bumps = latestBreakingBumps(versions);
    const rows = [
      { task_id: "t-major", created_at: "2026-01-15T00:00:00Z" },
      { task_id: "t-major", created_at: "2026-01-16T00:00:00Z" },
      { task_id: "t-major", created_at: "2026-02-05T00:00:00Z" }, // fresh
      { task_id: "t-minor", created_at: "2026-02-15T00:00:00Z" },
      { task_id: "t-patch", created_at: "2020-01-01T00:00:00Z" },
    ];
    const summary = staleRowSummary(rows, bumps);
    assert.equal(summary.staleCount, 3);
    assert.deepEqual(summary.byTask, [
      { task_id: "t-major", count: 2, version: "2.0.0" },
      { task_id: "t-minor", count: 1, version: "1.1.0" },
    ]);
  });
});

describe("understudy benchmarks upgrade (CLI)", () => {
  const bin = path.resolve("dist/bin.js");

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us-upgrade-"));
    const oldM = manifest([task("t1"), task("t2")]);
    const newM = manifest([task("t1", { instruction: "changed" }), task("t2", { title: "renamed" })]);
    fs.writeFileSync(path.join(dir, "benchmark.json"), JSON.stringify(newM, null, 2));
    const againstPath = path.join(dir, "old-manifest.json");
    fs.writeFileSync(againstPath, JSON.stringify(oldM, null, 2));
    return { dir, againstPath };
  }

  it("appends one valid understudy.benchmark_version.v1 line to versions.jsonl", () => {
    const { dir, againstPath } = setup();
    const out = execFileSync(process.execPath, [bin, "benchmarks", "upgrade", dir, "--against", againstPath, "--note", "test upgrade"], {
      encoding: "utf8",
    });
    const result = JSON.parse(out);
    assert.deepEqual(result.diff.plan.rerun, ["t1"]);
    assert.deepEqual(result.diff.plan.reuse, ["t2"]);
    assert.equal(result.benchmark_version.to, "2.0.0");
    assert.equal(result.queued_run, null);

    const lines = fs.readFileSync(path.join(dir, "versions.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.schema_version, "understudy.benchmark_version.v1");
    assert.equal(typeof entry.created_at, "string");
    assert.equal(entry.version, "2.0.0");
    assert.equal(entry.note, "test upgrade");
    assert.equal(entry.task_bumps.length, 2);

    // Second run: baseline comes from the newest versions.jsonl line (append-only ledger grows).
    const out2 = execFileSync(process.execPath, [bin, "benchmarks", "upgrade", dir, "--against", againstPath], { encoding: "utf8" });
    assert.equal(JSON.parse(out2).benchmark_version.from, "2.0.0");
    assert.equal(JSON.parse(out2).benchmark_version.to, "3.0.0");
    assert.equal(fs.readFileSync(path.join(dir, "versions.jsonl"), "utf8").split("\n").filter(Boolean).length, 2);
  });

  it("--dry-run prints the plan without touching versions.jsonl", () => {
    const { dir, againstPath } = setup();
    const out = execFileSync(process.execPath, [bin, "benchmarks", "upgrade", dir, "--against", againstPath, "--dry-run"], {
      encoding: "utf8",
    });
    assert.equal(JSON.parse(out).benchmark_version.to, "2.0.0");
    assert.equal(fs.existsSync(path.join(dir, "versions.jsonl")), false);
  });

  it("--queue writes a run_request for the rerun set only (queueing, never executing)", () => {
    const { dir, againstPath } = setup();
    const out = execFileSync(
      process.execPath,
      [bin, "benchmarks", "upgrade", dir, "--against", againstPath, "--queue", "--model", "test-model"],
      { encoding: "utf8" },
    );
    const result = JSON.parse(out);
    assert.ok(result.queued_run);
    assert.deepEqual(result.queued_run.tasks, ["t1"]); // rerun set only
    assert.deepEqual(result.queued_run.models, ["test-model"]);
    const queueDir = path.join(dir, "runs", "queue");
    assert.equal(fs.readdirSync(queueDir).length, 1);
  });

  it("rejects a versions-entry file as --against (needs the archived manifest)", () => {
    const { dir, againstPath } = setup();
    const entryPath = path.join(dir, "entry.json");
    fs.writeFileSync(entryPath, JSON.stringify({ created_at: "2026-01-01T00:00:00Z", version: "1.0.0", task_bumps: [] }));
    assert.throws(
      () => execFileSync(process.execPath, [bin, "benchmarks", "upgrade", dir, "--against", entryPath], { encoding: "utf8", stdio: "pipe" }),
      /previous benchmark manifest/,
    );
    void againstPath;
  });
});
