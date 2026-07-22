import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// lib/benchmark-core.ts is now a re-export of the repo's compiled
// dist/benchmark.js (runs-core pattern) — this test keeps guarding the
// contract in case the re-export ever regresses to a fork.
import * as vendored from "./.build/lib/benchmark-core.js";
import * as root from "../../../dist/benchmark.js";

const derived = JSON.parse(fs.readFileSync(path.resolve("../../tests/fixtures/benchmark-derived.json"), "utf8"));
const imported = JSON.parse(fs.readFileSync(path.resolve("../../tests/fixtures/benchmark-imported.json"), "utf8"));

const badManifest = {
  schema_version: "understudy.benchmark.v0",
  provenance: { origin: "imported" },
  taxonomy: [{ category_id: "a" }],
  tasks: [
    { task_id: "t1", category_id: "b", genesis: "cloned", split: "test", gold: { kind: "vibes" } },
    "not-an-object",
  ],
  environment: { format: "docker" },
  verifier: { kind: "coin-flip" },
};

// A shared trace-DAG fixture exercising branching, orphans, and cycles.
const traceRecords = [
  { id: "root", task_id: "t1", metrics: { strict: 0.5, dense: 0.4 } },
  { id: "a", parents: ["root"], reward: 1 },
  { id: "b", parents: ["root"], reward: 0, metrics: { strict: 0, dense: 0.1 } },
  { id: "leaf-a", parent_ids: "a", reward: 2.5 }, // out-of-0..1 reward
  { message_id: "orphan", parents: ["missing-parent"], task: { id: "t2" }, reward: 0.25 },
  { id: "cyc-1", parents: ["cyc-2"] },
  { id: "cyc-2", parents: ["cyc-1"], reward: 0.75 },
  { not: "usable" },
];

function pipeline(mod, manifest) {
  const nodes = traceRecords.map((r) => mod.normalizeTraceRecord(r)).filter((n) => n !== null);
  const branches = mod.extractBranches(nodes);
  const rows = mod.projectBranchesToEvalRows(manifest, branches, {
    runId: "drift-run",
    model: "drift-model",
    route: "local",
  });
  return { nodes, branches, rows };
}

describe("vendored lib/benchmark-core.ts behavior-equals src/benchmark.ts", () => {
  it("validateBenchmarkManifest agrees on valid fixtures", () => {
    for (const manifest of [derived, imported]) {
      assert.deepEqual(vendored.validateBenchmarkManifest(manifest), root.validateBenchmarkManifest(manifest));
      assert.deepEqual(vendored.validateBenchmarkManifest(manifest), []);
    }
  });

  it("validateBenchmarkManifest agrees error-for-error on a broken manifest", () => {
    const v = vendored.validateBenchmarkManifest(badManifest);
    const r = root.validateBenchmarkManifest(badManifest);
    assert.deepEqual(v, r);
    assert.ok(v.length > 0);
    assert.deepEqual(vendored.validateBenchmarkManifest("nope"), root.validateBenchmarkManifest("nope"));
  });

  it("normalizeTraceRecord + extractBranches produce identical branches", () => {
    const v = pipeline(vendored, derived);
    const r = pipeline(root, derived);
    assert.deepEqual(v.nodes, r.nodes);
    assert.deepEqual(v.branches, r.branches);
    assert.ok(v.branches.length >= 3, "fixture should produce multiple branches");
  });

  it("projectBranchesToEvalRows produces identical eval rows", () => {
    for (const manifest of [derived, imported]) {
      const v = pipeline(vendored, manifest);
      const r = pipeline(root, manifest);
      assert.deepEqual(v.rows, r.rows);
    }
  });
});
