import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertionSatisfied,
  auditObservationLeakage,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
} from "../dist/synthetic-workflow-offline.js";
import {
  FROZEN_HOLDOUT_SHA256,
  SLICE,
  SLICE_TASKS,
  sliceCounts,
  sliceSplitSha256,
  slicePool,
} from "../experiments/workload-orchestrator/slice.mjs";

describe("WL-OR slice pin", () => {
  it("selects five orchestration families with inherited splits", () => {
    assert.equal(SLICE.slice_id, "wl-or-orchestrator-v1");
    assert.equal(SLICE_TASKS.length, 30);
    assert.deepEqual(sliceCounts(), { train: 20, dev: 5, holdout: 5 });
    assert.deepEqual(new Set(SLICE_TASKS.map((task) => task.family)), new Set(SLICE.families));
  });

  it("pins the slice split hashes", () => {
    assert.equal(sliceSplitSha256("train"), "30448f43a2c6d4487b2bfd94e408d31823874b193aa37263db1885936b4cf51f");
    assert.equal(sliceSplitSha256("dev"), "026b432843e809da47f96df3e593d058e4b3f1994a40d895486812a48607edae");
    assert.equal(sliceSplitSha256("holdout"), "a5337d711cf29117c2b7b5d3075f823e17f214102825dfc874d26066808f760d");
  });
});

describe("WL-OR slice gates", () => {
  it("scores every oracle at one with no forbidden writes", () => {
    for (const task of SLICE_TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, task.taskId);
      assert.deepEqual(result.forbiddenEffects, [], task.taskId);
    }
  });

  it("scores the activity sentinel at zero", () => {
    for (const task of SLICE_TASKS) {
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, task.taskId);
    }
  });

  it("pays no free credit and leaks no grader labels", () => {
    for (const task of SLICE_TASKS) {
      assert.ok(task.assertions.some((assertion) => !assertionSatisfied(task.initialState, assertion)), task.taskId);
      assert.deepEqual(auditObservationLeakage(reset(task.taskId).obs, task), [], task.taskId);
    }
  });

  it("refuses the holdout without the frozen hash", () => {
    assert.throws(() => slicePool("holdout"), /frozen-holdout refusal/);
    assert.equal(slicePool("holdout", FROZEN_HOLDOUT_SHA256).length, 5);
  });
});
