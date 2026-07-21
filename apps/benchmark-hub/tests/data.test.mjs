import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { getEntry, loadHub } from "./.build/lib/data-core.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-data-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const validManifest = (benchmarkId) => ({
  schema_version: "understudy.benchmark.v1",
  benchmark_id: benchmarkId,
  provenance: { origin: "authored" },
  taxonomy: [{ category_id: "cat-a" }],
  tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
  environment: { format: "verifiers.v1", package_ref: "pkg" },
  verifier: { kind: "reward-fns", strict_metric: "strict" },
});

function writeBenchmark(name, manifest, rowsLines = [], flagsLines = []) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  if (rowsLines.length > 0) fs.writeFileSync(path.join(dir, "rows-a.jsonl"), rowsLines.join("\n") + "\n");
  if (flagsLines.length > 0) fs.writeFileSync(path.join(dir, "flags.jsonl"), flagsLines.join("\n") + "\n");
  return dir;
}

const row = (over = {}) =>
  JSON.stringify({
    schema_version: "understudy.eval_result.v1",
    run_id: "r1",
    task_id: "t1",
    status: "ok",
    score: 1,
    model: "m",
    ...over,
  });

describe("data-core loader", () => {
  it("malformed manifest JSON becomes a visible invalid entry, not a silent absence", () => {
    writeBenchmark("broken-json", "{ this is not json");
    const entry = getEntry("data--broken-json");
    assert.equal(entry.kind, "invalid");
    assert.match(entry.errors[0], /not valid JSON/);
  });

  it("manifest failing validation becomes an invalid entry carrying its errors", () => {
    writeBenchmark("bad-manifest", {
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "bad",
      provenance: { origin: "not-an-origin" },
      taxonomy: [],
      tasks: [],
      environment: { format: "verifiers.v1", package_ref: "pkg" },
      // verifier missing
    });
    const entry = getEntry("data--bad-manifest");
    assert.equal(entry.kind, "invalid");
    assert.ok(entry.errors.some((e) => e.includes("provenance.origin")));
    assert.ok(entry.errors.some((e) => e.includes("verifier")));
  });

  it("schema_version gate: a manifest with the wrong stamp is invalid", () => {
    writeBenchmark("wrong-schema", { ...validManifest("x"), schema_version: "understudy.benchmark.v2" });
    const entry = getEntry("data--wrong-schema");
    assert.equal(entry.kind, "invalid");
    assert.ok(entry.errors.some((e) => e.includes("schema_version")));
  });

  it("counts malformed jsonl lines and drops wrong-schema rows", () => {
    writeBenchmark("diag", validManifest("diag-bench"), [
      row(),
      "{{{ not json",
      row({ schema_version: "something.else.v9" }),
    ]);
    const entry = getEntry("data--diag");
    assert.equal(entry.kind, "ok");
    assert.equal(entry.rows.length, 1);
    assert.equal(entry.diagnostics.skippedLines, 1);
    assert.equal(entry.diagnostics.droppedRows, 1);
  });

  it("drops and counts rows/flags whose benchmark_id names another benchmark", () => {
    const flag = (over = {}) =>
      JSON.stringify({
        schema_version: "understudy.benchmark_flag.v1",
        benchmark_id: "foreign-bench",
        task_id: null,
        reason: "other",
        note: "",
        created_at: "2026-01-01T00:00:00Z",
        status: "open",
        ...over,
      });
    writeBenchmark(
      "foreign",
      validManifest("home-bench"),
      [row({ benchmark_id: "home-bench" }), row({ benchmark_id: "other-bench" }), row()],
      [flag({ benchmark_id: "home-bench" }), flag()],
    );
    const entry = getEntry("data--foreign");
    assert.equal(entry.kind, "ok");
    assert.equal(entry.rows.length, 2); // matching id + id-less row kept
    assert.equal(entry.diagnostics.foreignRows, 1);
    assert.equal(entry.flags.length, 1);
    assert.equal(entry.diagnostics.foreignFlags, 1);
  });

  it("loadHub returns both ok and invalid entries from the env data dir; demo data stays gated", () => {
    const entries = loadHub();
    assert.ok(entries.every((e) => e.slug.startsWith("data--")), "no demo/fixture entries without BENCHMARK_HUB_DEMO");
    assert.ok(entries.some((e) => e.kind === "ok"));
    assert.ok(entries.some((e) => e.kind === "invalid"));
  });

  it("getEntry rejects traversal-shaped slugs", () => {
    assert.equal(getEntry("data--../escape"), null);
    assert.equal(getEntry("nonsense"), null);
  });
});
