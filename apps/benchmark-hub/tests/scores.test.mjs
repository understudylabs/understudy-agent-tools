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

  it("anomaly-flagged rows are excluded from score/cost/latency aggregates but counted (marked, not dropped)", () => {
    const rows = [
      row({ score: 1, cost: 1, latency_ms: 100 }),
      // A silent zero: ok status, score 0, flagged by the executor's sentinel.
      row({ task_id: "t2", score: 0, cost: 9, latency_ms: 9000, anomaly: { kind: "zero_score_zero_calls", detail: "score 0, zero tool calls" } }),
    ];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, 1, "the anomalous zero never drags the mean");
    assert.equal(s.totalCost, 1);
    assert.equal(s.p50LatencyMs, 100);
    assert.equal(s.scoredCount, 1);
    assert.equal(s.anomalousCount, 1, "count stays visible");
    assert.equal(s.taskCount, 2, "the anomalous row's task is still counted");
  });

  it("includeAnomalous opts flagged rows back into the aggregates", () => {
    const rows = [
      row({ score: 1 }),
      row({ task_id: "t2", score: 0, anomaly: { kind: "no_tool_calls", detail: "x" } }),
    ];
    const [s] = computeLeaderboard(manifest, rows, { includeAnomalous: true });
    assert.equal(s.overall, 0.5);
    assert.equal(s.anomalousCount, 1);
  });

  it("clean rows report anomalousCount 0 (additive field, older rows unaffected)", () => {
    const [s] = computeLeaderboard(manifest, [row({ score: 1 })]);
    assert.equal(s.anomalousCount, 0);
  });

  it("flags incumbent arms from row arm_kind; unlabeled rows stay candidate", () => {
    const rows = [
      row({ model: "gpt-4o", arm_kind: "incumbent" }),
      row({ model: "challenger", arm_kind: "candidate" }),
      row({ model: "legacy-rows" }), // pre-arm_kind rows
    ];
    const summaries = computeLeaderboard(manifest, rows);
    const byModel = Object.fromEntries(summaries.map((s) => [s.model, s.incumbent]));
    assert.equal(byModel["gpt-4o"], true);
    assert.equal(byModel["challenger"], false);
    assert.equal(byModel["legacy-rows"], false);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap 95% CIs + statistical-tie treatment (seeded, deterministic).
// ---------------------------------------------------------------------------
import { bootstrapCI, perTaskMeans } from "./.build/lib/bootstrap.js";
import { formatCI, statisticalTieGroups } from "./.build/lib/scores.js";

describe("bootstrapCI", () => {
  const means = [0.2, 0.4, 0.6, 0.8, 1.0, 0.0, 0.5, 0.7];

  it("is deterministic for the same seed (no Math.random)", () => {
    const orig = Math.random;
    Math.random = () => { throw new Error("Math.random must not be consulted"); };
    try {
      const a = bootstrapCI(means, { seed: "bench::model-a" });
      const b = bootstrapCI(means, { seed: "bench::model-a" });
      assert.deepEqual(a, b);
      assert.equal(a.iterations, 2000);
      assert.equal(a.taskN, means.length);
      assert.ok(a.lo <= a.mean && a.mean <= a.hi);
      assert.ok(a.lo < a.hi, "real between-task variance yields a non-degenerate interval");
    } finally {
      Math.random = orig;
    }
  });

  it("different seeds resample differently (arms don't share draws)", () => {
    const a = bootstrapCI(means, { seed: "bench::model-a" });
    const b = bootstrapCI(means, { seed: "bench::model-b" });
    assert.notDeepEqual([a.lo, a.hi], [b.lo, b.hi]);
  });

  it("N=1 task collapses to a degenerate [mean, mean] interval", () => {
    const ci = bootstrapCI([0.75], { seed: "s" });
    assert.deepEqual([ci.lo, ci.mean, ci.hi, ci.taskN], [0.75, 0.75, 0.75, 1]);
  });

  it("zero tasks yields null", () => {
    assert.equal(bootstrapCI([], { seed: "s" }), null);
  });

  it("perTaskMeans collapses rollout repeats before resampling", () => {
    assert.deepEqual(perTaskMeans([["t1", 1], ["t1", 0], ["t2", 1]]).sort(), [0.5, 1]);
  });
});

describe("leaderboard CI + statistical ties", () => {
  it("computeLeaderboard attaches a per-arm CI over per-task means, excluding anomalous rows", () => {
    const rows = [
      row({ score: 1 }),
      row({ task_id: "t2", score: 0 }),
      row({ task_id: "t3", score: 0.5 }),
      row({ task_id: "t3", score: 0, anomaly: { kind: "no_tool_calls", detail: "x" } }),
    ];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.scoredTaskCount, 3);
    assert.ok(s.ci);
    assert.equal(s.ci.taskN, 3, "anomalous rollout never enters the resampled task means");
    assert.ok(s.ci.lo <= s.ci.hi);
    // Deterministic across recomputation (same benchmark + model seed).
    const [again] = computeLeaderboard(manifest, rows);
    assert.deepEqual(s.ci, again.ci);
  });

  it("all-anomalous arm has null CI and zero scored tasks", () => {
    const rows = [
      row({ score: 1, anomaly: { kind: "empty_prompt", detail: "x" } }),
      row({ task_id: "t2", score: 1, anomaly: { kind: "empty_prompt", detail: "x" } }),
    ];
    const [s] = computeLeaderboard(manifest, rows);
    assert.equal(s.overall, null);
    assert.equal(s.ci, null);
    assert.equal(s.scoredTaskCount, 0);
  });

  it("statisticalTieGroups chains adjacent overlapping CIs; clear separations stay ranked", () => {
    const arm = (model, overall, lo, hi) => ({ model, overall, ci: { lo, hi, mean: overall, iterations: 2000, taskN: 5 } });
    const groups = statisticalTieGroups([
      arm("top", 0.9, 0.85, 0.95),
      arm("mid-a", 0.6, 0.5, 0.7),
      arm("mid-b", 0.55, 0.45, 0.65), // overlaps mid-a
      arm("bottom", 0.1, 0.05, 0.15),
      { model: "no-ci", overall: 0.5, ci: null },
    ]);
    assert.equal(groups.has("top"), false, "clear winner is not greyed");
    assert.equal(groups.has("bottom"), false);
    assert.equal(groups.has("no-ci"), false, "arms without a CI never tie");
    assert.equal(groups.get("mid-a"), groups.get("mid-b"), "overlapping neighbors share a tie group");
  });

  it("formatCI renders the percent idiom", () => {
    assert.equal(formatCI({ lo: 0.615, hi: 0.809, mean: 0.7, iterations: 2000, taskN: 4 }), "[62–81%]");
    assert.equal(formatCI(null), "");
  });
});
