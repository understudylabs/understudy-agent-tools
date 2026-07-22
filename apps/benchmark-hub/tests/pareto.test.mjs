import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Compiled by `tsc -p tests/tsconfig.json` (see package.json "test" script).
import {
  availableAxes,
  paretoFrontier,
  paretoPointsToCsv,
  paretoTieGroups,
  projectParetoPoints,
} from "./.build/lib/pareto.js";

const row = (over = {}) => ({
  schema_version: "understudy.eval_result.v1",
  run_id: "r1",
  task_id: "t1",
  status: "ok",
  score: 1,
  model: "m",
  ...over,
});

const point = (over = {}) => ({
  model: "m",
  quality: 0.5,
  ci: null,
  costPerTask: 1,
  latencyMeanMs: 100,
  tokensPerSec: null,
  memoryMb: null,
  scoredTaskCount: 2,
  scoredRowCount: 2,
  trivial: false,
  incumbent: false,
  ...over,
});

const QC = [
  { key: "quality", direction: "max" },
  { key: "costPerTask", direction: "min" },
];

describe("projectParetoPoints", () => {
  it("quality is the macro-average of per-task means; anomalous rows excluded", () => {
    const rows = [
      row({ task_id: "t1", score: 1 }),
      row({ task_id: "t1", score: 0 }), // t1 mean = 0.5
      row({ task_id: "t2", score: 1 }), // t2 mean = 1
      row({ task_id: "t2", score: 0, anomaly: { kind: "loop", detail: "x" } }), // excluded
    ];
    const [p] = projectParetoPoints(rows, { benchmarkId: "b" });
    assert.equal(p.quality, 0.75);
    assert.equal(p.scoredTaskCount, 2);
    assert.equal(p.scoredRowCount, 3);
    assert.ok(p.ci);
    assert.ok(p.ci.lo <= 0.75 && p.ci.hi >= 0.75);
  });

  it("null-cost handling: costPerTask is null when no rows carry cost, mean over carriers otherwise", () => {
    const noCost = projectParetoPoints([row(), row({ task_id: "t2" })]);
    assert.equal(noCost[0].costPerTask, null);
    const mixed = projectParetoPoints([row({ cost: 0.2 }), row({ task_id: "t2" }), row({ task_id: "t3", cost: 0.4 })]);
    assert.equal(mixed[0].costPerTask, 0.30000000000000004);
    assert.equal(mixed[0].latencyMeanMs, null);
  });

  it("perf fields: tokens/sec and memory (gb normalized to mb) aggregate when present", () => {
    const rows = [
      row({ tokens_per_sec: 100, memory_gb: 2 }),
      row({ task_id: "t2", tokens_per_sec: 200, memory_mb: 1024 }),
    ];
    const [p] = projectParetoPoints(rows);
    assert.equal(p.tokensPerSec, 150);
    assert.equal(p.memoryMb, 1536);
  });

  it("flags trivial and incumbent arms; excluded tasks never aggregate; output sorted by model", () => {
    const rows = [
      row({ model: "z-null", arm_kind: "null_agent", score: 0 }),
      row({ model: "a-inc", arm_kind: "incumbent" }),
      row({ model: "a-inc", task_id: "flagged", score: 0 }),
    ];
    const pts = projectParetoPoints(rows, { excludeTaskIds: new Set(["flagged"]) });
    assert.deepEqual(pts.map((p) => p.model), ["a-inc", "z-null"]);
    assert.equal(pts[0].incumbent, true);
    assert.equal(pts[0].quality, 1); // flagged task excluded
    assert.equal(pts[1].trivial, true);
  });

  it("deterministic: same rows in any order yield identical points (incl. CI)", () => {
    const rows = [row({ task_id: "t1", score: 1 }), row({ task_id: "t2", score: 0 }), row({ task_id: "t3", score: 1 })];
    const a = projectParetoPoints(rows, { benchmarkId: "b" });
    const b = projectParetoPoints([...rows].reverse(), { benchmarkId: "b" });
    assert.deepEqual(a, b);
  });
});

describe("paretoFrontier", () => {
  it("keeps only non-dominated points (maximize quality, minimize cost)", () => {
    const pts = [
      point({ model: "cheap-ok", quality: 0.6, costPerTask: 0.1 }),
      point({ model: "pricey-great", quality: 0.9, costPerTask: 1 }),
      point({ model: "pricey-bad", quality: 0.5, costPerTask: 2 }), // dominated twice over
      point({ model: "mid-dominated", quality: 0.55, costPerTask: 0.5 }), // dominated by cheap-ok
    ];
    assert.deepEqual(paretoFrontier(pts, QC).map((p) => p.model), ["pricey-great", "cheap-ok"]);
  });

  it("degenerate: one arm dominates everything — frontier is that single arm", () => {
    const pts = [
      point({ model: "king", quality: 0.9, costPerTask: 0.1 }),
      point({ model: "a", quality: 0.5, costPerTask: 0.5 }),
      point({ model: "b", quality: 0.8, costPerTask: 0.2 }),
    ];
    assert.deepEqual(paretoFrontier(pts, QC).map((p) => p.model), ["king"]);
  });

  it("exact ties dominate neither way: both stay, ordered deterministically by model", () => {
    const pts = [
      point({ model: "zeta", quality: 0.7, costPerTask: 0.3 }),
      point({ model: "alpha", quality: 0.7, costPerTask: 0.3 }),
    ];
    assert.deepEqual(paretoFrontier(pts, QC).map((p) => p.model), ["alpha", "zeta"]);
  });

  it("trivial floors and null-objective points never enter the frontier", () => {
    const pts = [
      point({ model: "null-agent", quality: 0.95, costPerTask: 0, trivial: true }),
      point({ model: "no-cost", quality: 0.9, costPerTask: null }),
      point({ model: "real", quality: 0.6, costPerTask: 0.5 }),
    ];
    assert.deepEqual(paretoFrontier(pts, QC).map((p) => p.model), ["real"]);
  });

  it("maximize-x objective (tokens/sec) flips domination direction", () => {
    const pts = [
      point({ model: "slow-good", quality: 0.9, tokensPerSec: 50 }),
      point({ model: "fast-ok", quality: 0.6, tokensPerSec: 200 }),
      point({ model: "slow-ok", quality: 0.6, tokensPerSec: 40 }), // dominated by both
    ];
    const f = paretoFrontier(pts, [
      { key: "quality", direction: "max" },
      { key: "tokensPerSec", direction: "max" },
    ]);
    assert.deepEqual(f.map((p) => p.model), ["slow-good", "fast-ok"]);
  });
});

describe("paretoTieGroups", () => {
  it("chains adjacent CI overlaps into groups; trivial arms never tie", () => {
    const pts = [
      point({ model: "a", quality: 0.8, ci: { lo: 0.7, hi: 0.9, mean: 0.8, iterations: 2000, taskN: 5 } }),
      point({ model: "b", quality: 0.75, ci: { lo: 0.65, hi: 0.85, mean: 0.75, iterations: 2000, taskN: 5 } }),
      point({ model: "c", quality: 0.3, ci: { lo: 0.25, hi: 0.35, mean: 0.3, iterations: 2000, taskN: 5 } }),
      point({ model: "floor", quality: 0.79, trivial: true, ci: { lo: 0.7, hi: 0.9, mean: 0.79, iterations: 2000, taskN: 5 } }),
    ];
    const groups = paretoTieGroups(pts);
    assert.equal(groups.get("a"), 0);
    assert.equal(groups.get("b"), 0);
    assert.equal(groups.has("c"), false);
    assert.equal(groups.has("floor"), false);
  });
});

describe("availableAxes / CSV", () => {
  it("axes need >=2 non-trivial arms carrying quality + the value", () => {
    const pts = [
      point({ model: "a", costPerTask: 1, latencyMeanMs: 10, tokensPerSec: null }),
      point({ model: "b", costPerTask: 2, latencyMeanMs: null, tokensPerSec: 100 }),
      point({ model: "floor", costPerTask: 0, latencyMeanMs: 1, tokensPerSec: 500, trivial: true }),
    ];
    assert.deepEqual(availableAxes(pts), ["costPerTask"]);
  });

  it("CSV: header + one row per arm, nulls as empty cells, commas/quotes escaped", () => {
    const csv = paretoPointsToCsv([
      point({ model: 'weird, "model"', quality: 0.5, costPerTask: null, ci: { lo: 0.4, hi: 0.6, mean: 0.5, iterations: 2000, taskN: 3 } }),
    ]);
    const [header, line] = csv.trim().split("\n");
    assert.equal(header.split(",").length, 12);
    assert.ok(line.startsWith('"weird, ""model""",0.5,0.4,0.6,,100,'));
    assert.ok(line.endsWith("false,false"));
  });
});
