import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveAutoReviewProposals,
  deriveTaskAttention,
  effectiveDecision,
} from "../dist/benchmark-hub-core.js";
import { DEFAULT_REVIEW_POLICY } from "../dist/benchmark-artifacts.js";

function task(id, overrides = {}) {
  return {
    schema_version: "understudy.benchmark_task.v1",
    task_id: id,
    execution_group: "g1",
    title: `task ${id}`,
    status: "machine_proposed",
    split: "construction",
    candidate_boundary: "b",
    machine_confidence: "high",
    close_call: false,
    tool_surface: [],
    outcome_contract: { required: [], preserved: [], forbidden: [], grading: "final_state" },
    world_model: {},
    source: { node_ids: [], edges: [], captures: [] },
    claims: [],
    sentinels: [],
    review: { decision: "pending" },
    ...overrides,
  };
}

function entryWith(overrides = {}) {
  return {
    kind: "proposed",
    slug: "data--x",
    source: "data-dir",
    readOnly: false,
    dir: "/tmp/x",
    manifestPath: "/tmp/x/manifest.json",
    foundry: { schema_version: "understudy.trace_foundry.v1" },
    tasks: [],
    dag: null,
    captureIndex: [],
    rows: [],
    reviews: [],
    latestReviewByTask: {},
    diagnostics: { skippedLines: 0, droppedRows: 0, foreignRows: 0, foreignFlags: 0 },
    crossCheckErrors: [],
    overview: null,
    calibration: null,
    ...overrides,
  };
}

const reviewLine = (taskId, decision, source) => ({
  schema_version: "understudy.benchmark_review.v1",
  benchmark_id: "b",
  task_id: taskId,
  decision,
  note: "",
  created_at: "2026-07-22T00:00:00.000Z",
  ...(source ? { source } : {}),
});

/* ------------------------------------------------------------------ */
/* Born accepted: effectiveDecision + deriveTaskAttention              */
/* ------------------------------------------------------------------ */

describe("effectiveDecision — born-accepted derivation", () => {
  it("no review line ⇒ accepted (implicit) under the default policy", () => {
    const entry = entryWith({ tasks: [task("t1")] });
    assert.deepEqual(effectiveDecision(entry, "t1"), { decision: "accept", explicit: false });
  });

  it("attention flags never block the effective accept (flags ≠ blockers)", () => {
    const entry = entryWith({
      tasks: [task("t1", { machine_confidence: "low", self_check: { ok: false, failures: [] } })],
    });
    assert.deepEqual(effectiveDecision(entry, "t1"), { decision: "accept", explicit: false });
    assert.deepEqual(deriveTaskAttention(entry)[0].flags, ["low_confidence", "self_check_failed"]);
  });

  it("an explicit override always wins (reject / needs_more / restrict / re-accept)", () => {
    for (const d of ["reject", "needs_more", "restrict", "accept"]) {
      const entry = entryWith({ tasks: [task("t1")], latestReviewByTask: { t1: reviewLine("t1", d) } });
      assert.deepEqual(effectiveDecision(entry, "t1"), { decision: d, explicit: true });
    }
  });

  it("policy default_decision 'pending' restores the old flow: no line ⇒ null", () => {
    const entry = entryWith({
      tasks: [task("t1")],
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY, default_decision: "pending" },
    });
    assert.deepEqual(effectiveDecision(entry, "t1"), { decision: null, explicit: false });
    // …and an explicit accept still decides under pending mode.
    const accepted = entryWith({
      tasks: [task("t1")],
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY, default_decision: "pending" },
      latestReviewByTask: { t1: reviewLine("t1", "accept", "auto") },
    });
    assert.deepEqual(effectiveDecision(accepted, "t1"), { decision: "accept", explicit: true });
  });
});

describe("deriveTaskAttention — flag matrix over ALL tasks", () => {
  it("covers every task, including explicitly reviewed ones (unlike the proposals)", () => {
    const entry = entryWith({
      tasks: [task("t-clean"), task("t-flagged", { machine_confidence: "low" })],
      latestReviewByTask: { "t-flagged": reviewLine("t-flagged", "reject") },
    });
    assert.deepEqual(deriveTaskAttention(entry), [
      { task_id: "t-clean", flags: [] },
      { task_id: "t-flagged", flags: ["low_confidence"] },
    ]);
    // The legacy proposals skip the decided task but agree on the signals.
    assert.deepEqual(deriveAutoReviewProposals(entry), [
      { task_id: "t-clean", verdict: "auto_accept", reasons: [] },
    ]);
  });

  it("flags compound in AUTO_REVIEW_REASONS order and honor the policy bar", () => {
    const calibration = {
      schema_version: "understudy.calibration.v1",
      benchmark_id: "b",
      run_id: "r",
      incumbent_models: ["m"],
      threshold: 0.5,
      started_at: null,
      finished_at: null,
      tasks: [{ task_id: "t1", score: 0, passed: false, rollouts: 1 }],
      passed_count: 0,
      failed_count: 1,
      failed_task_ids: ["t1"],
    };
    const entry = entryWith({
      tasks: [task("t1", { machine_confidence: "low", self_check: { ok: false, failures: [] } })],
      calibration,
      crossCheckErrors: ["t1 missing from benchmark.json"],
      rows: [
        {
          schema_version: "understudy.eval_result.v1",
          run_id: "r",
          task_id: "t1",
          status: "ok",
          anomaly: { kind: "runaway", detail: "d" },
        },
      ],
    });
    assert.deepEqual(deriveTaskAttention(entry)[0].flags, [
      "low_confidence",
      "self_check_failed",
      "incumbent_failed",
      "schema_conflict",
      "anomaly",
    ]);
    // require_incumbent_pass=false drops the incumbent flag only.
    const relaxed = entryWith({
      tasks: [task("t1")],
      calibration,
      reviewPolicy: { ...DEFAULT_REVIEW_POLICY, require_incumbent_pass: false },
    });
    assert.deepEqual(deriveTaskAttention(relaxed)[0].flags, []);
  });
});
