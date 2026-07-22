import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Compiled by `tsc -p tests/tsconfig.json` — same pattern as scores.test.mjs.
import {
  calibrationFloors,
  computeLeaderboard,
  formatFloor,
  isTrivialArmRow,
  statisticalTieGroups,
  trivialPassesForTask,
  TRIVIAL_ARM_KINDS,
} from "./.build/lib/scores.js";

const manifest = {
  schema_version: "understudy.benchmark.v1",
  benchmark_id: "bench-f",
  provenance: { origin: "authored" },
  taxonomy: [{ category_id: "cat-a" }],
  tasks: [
    { task_id: "t1", category_id: "cat-a", genesis: "authored", split: "holdout" },
    { task_id: "t2", category_id: "cat-a", genesis: "authored", split: "holdout" },
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

const calibration = {
  schema_version: "understudy.calibration.v1",
  benchmark_id: "bench-f",
  run_id: "run-cal",
  incumbent_models: ["m"],
  threshold: 1,
  started_at: null,
  finished_at: null,
  tasks: [],
  passed_count: 0,
  failed_count: 0,
  failed_task_ids: [],
  null_floor: { arm_kind: "null_agent", floor: 0, passed_task_ids: [], floor_exceeded: false },
  spam_floor: { arm_kind: "spam_agent", floor: 0.5, passed_task_ids: ["t1"], floor_exceeded: true },
};

describe("trivial-arm row detection", () => {
  it("flags null_agent and spam_agent rows, not incumbent/candidate", () => {
    assert.deepEqual([...TRIVIAL_ARM_KINDS], ["null_agent", "spam_agent"]);
    assert.equal(isTrivialArmRow(row({ arm_kind: "null_agent" })), true);
    assert.equal(isTrivialArmRow(row({ arm_kind: "spam_agent" })), true);
    assert.equal(isTrivialArmRow(row({ arm_kind: "incumbent" })), false);
    assert.equal(isTrivialArmRow(row({ arm_kind: "candidate" })), false);
    assert.equal(isTrivialArmRow(row({})), false);
  });

  it("computeLeaderboard marks trivial arms; candidates stay unmarked", () => {
    const rows = [
      row({ model: "null_agent", arm_kind: "null_agent", score: 0 }),
      row({ model: "candidate-x", score: 1 }),
    ];
    const byModel = new Map(computeLeaderboard(manifest, rows).map((s) => [s.model, s]));
    assert.equal(byModel.get("null_agent").trivial, true);
    assert.equal(byModel.get("candidate-x").trivial, false);
  });

  it("trivial arms never enter statistical-tie groups (floors are not candidates)", () => {
    // Two identically-scored arms would tie; the trivial one is excluded, so
    // no tie group forms at all (groups need >= 2 members).
    const rows = [
      row({ model: "spam_agent", arm_kind: "spam_agent", score: 0.5 }),
      row({ model: "spam_agent", arm_kind: "spam_agent", task_id: "t2", score: 0.5 }),
      row({ model: "candidate-x", score: 0.5 }),
      row({ model: "candidate-x", task_id: "t2", score: 0.5 }),
    ];
    const summaries = computeLeaderboard(manifest, rows);
    const ties = statisticalTieGroups(summaries);
    assert.equal(ties.size, 0);
    // Sanity: without the trivial label the same numbers DO tie.
    const untied = summaries.map((s) => ({ ...s, trivial: false }));
    assert.equal(statisticalTieGroups(untied).size, 2);
  });
});

describe("calibration floors rendering helpers", () => {
  it("calibrationFloors normalizes null then spam, with labels and exceeded flags", () => {
    const floors = calibrationFloors(calibration);
    assert.deepEqual(floors.map((f) => f.armKind), ["null_agent", "spam_agent"]);
    assert.deepEqual(floors.map((f) => f.label), ["null agent", "spam agent"]);
    assert.equal(floors[0].exceeded, false);
    assert.equal(floors[1].exceeded, true);
    assert.deepEqual(floors[1].passedTaskIds, ["t1"]);
  });

  it("handles absent floors and absent calibration (pre-floors sidecars stay renderable)", () => {
    assert.deepEqual(calibrationFloors(null), []);
    assert.deepEqual(calibrationFloors(undefined), []);
    const { null_floor, spam_floor, ...legacy } = calibration;
    assert.deepEqual(calibrationFloors(legacy), []);
    const nullOnly = { ...legacy, null_floor };
    assert.deepEqual(calibrationFloors(nullOnly).map((f) => f.armKind), ["null_agent"]);
  });

  it("formatFloor renders percents and the no-rows case", () => {
    assert.equal(formatFloor(0), "0%");
    assert.equal(formatFloor(0.5), "50%");
    assert.equal(formatFloor(null), "no rows");
  });

  it("trivialPassesForTask surfaces the suspect signal per task", () => {
    const passes = trivialPassesForTask(calibration, "t1");
    assert.equal(passes.length, 1);
    assert.equal(passes[0].armKind, "spam_agent");
    assert.equal(passes[0].label, "spam agent");
    assert.deepEqual(trivialPassesForTask(calibration, "t2"), []);
    assert.deepEqual(trivialPassesForTask(null, "t1"), []);
  });
});
