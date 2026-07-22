import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Compiled by `tsc -p tests/tsconfig.json` (see package.json "test" script):
// the pure lib is emitted as CJS into tests/.build so node:test can load it
// without a TS runtime.
import { computeLeaderboard } from "./.build/lib/scores.js";

const manifest = {
  schema_version: "understudy.benchmark.v1",
  benchmark_id: "bench-1",
  provenance: { origin: "authored" },
  taxonomy: [{ category_id: "cat-a" }, { category_id: "cat-b" }],
  tasks: [
    { task_id: "t1", category_id: "cat-a", genesis: "authored", split: "holdout" },
    { task_id: "t2", category_id: "cat-a", genesis: "authored", split: "holdout" },
    { task_id: "t3", category_id: "cat-b", genesis: "authored", split: "train" },
  ],
  environment: { format: "verifiers.v1", package_ref: "x" },
  verifier: { kind: "reward-fns", strict_metric: "strict" },
};

const row = (over = {}) => ({
  schema_version: "understudy.eval_result.v1",
  run_id: "r1",
  task_id: "t1",
  status: "ok",
  score: 1,
  model: "m",
  ...over,
});

describe("computeLeaderboard", () => {
  it("mixed statuses: only ok+score rows enter the score denominator", () => {
    const rows = [
      row({ score: 1 }),
      row({ task_id: "t2", score: 0 }),
      row({ task_id: "t2", status: "error", score: null }),
      row({ task_id: "t2", status: "unscored", score: null }),
      row({ task_id: "t2", status: "skipped", score: null }),
    ];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, 0.5);
    assert.equal(s.scoredCount, 2);
    assert.equal(s.errorCount, 1);
    assert.equal(s.unscoredCount, 2);
  });

  it("duplicate task rows each count once (per-row micro-average)", () => {
    const rows = [row({ score: 1 }), row({ score: 1 }), row({ score: 1 }), row({ task_id: "t2", score: 0 })];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, 0.75);
    assert.equal(s.taskCount, 2); // distinct tasks
  });

  it("unknown task_ids are scored but map to no category", () => {
    const rows = [row({ task_id: "mystery", score: 0.5 })];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, 0.5);
    assert.equal(s.perCategory["cat-a"], null);
    assert.equal(s.perCategory["cat-b"], null);
  });

  it("manifest frozen split beats row-declared split; row.split only used for unknown tasks", () => {
    const rows = [
      // manifest says t1 is holdout; the row lies and says train
      row({ split: "train", score: 1 }),
      // manifest says t3 is train; the row lies and says holdout
      row({ task_id: "t3", split: "holdout", score: 0 }),
      // unknown task: row.split is the only signal
      row({ task_id: "unknown-x", split: "holdout", score: 0 }),
    ];
    const holdout = computeLeaderboard(manifest, rows, { split: "holdout" })[0];
    assert.equal(holdout.scoredCount, 2); // t1 + unknown-x, NOT t3
    assert.equal(holdout.overall, 0.5);
    const train = computeLeaderboard(manifest, rows, { split: "train" })[0];
    assert.equal(train.scoredCount, 1); // t3 only
  });

  it("zero-score arm with real cost: totalCost kept, costPerSuccess null (C1 upstream lock)", () => {
    const rows = [row({ score: 0, cost: 1.25 }), row({ task_id: "t2", score: 0, cost: 0.75 })];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, 0);
    assert.equal(s.totalCost, 2);
    assert.equal(s.costPerSuccess, null);
  });

  it("null/absent costs give totalCost null", () => {
    const [s] = computeLeaderboard(manifest, [row({ cost: null }), row({ task_id: "t2" })]);
    assert.equal(s.totalCost, null);
    assert.equal(s.costPerSuccess, null);
  });

  it("cost and latency aggregate over scored rows only (same population as the score)", () => {
    const rows = [
      row({ score: 1, cost: 1, latency_ms: 100 }),
      row({ task_id: "t2", status: "error", score: null, cost: 50, latency_ms: 9999 }),
    ];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.totalCost, 1);
    assert.equal(s.p50LatencyMs, 100);
    assert.equal(s.costPerSuccess, 1); // 1 / 1 scored row / overall 1
  });

  it("p50 latency: odd count takes the middle, even count averages the two middles", () => {
    const odd = computeLeaderboard(manifest, [
      row({ latency_ms: 10 }),
      row({ latency_ms: 30 }),
      row({ latency_ms: 20 }),
    ])[0];
    assert.equal(odd.p50LatencyMs, 20);
    const even = computeLeaderboard(manifest, [
      row({ latency_ms: 10 }),
      row({ latency_ms: 20 }),
      row({ latency_ms: 30 }),
      row({ latency_ms: 40 }),
    ])[0];
    assert.equal(even.p50LatencyMs, 25);
  });

  it("excludeTaskIds removes flagged tasks from every aggregate", () => {
    const rows = [row({ score: 1 }), row({ task_id: "t2", score: 0, cost: 5 })];
    const [s] = computeLeaderboard(manifest, rows, { excludeTaskIds: new Set(["t2"]) });
    assert.equal(s.overall, 1);
    assert.equal(s.totalCost, null);
  });
});
