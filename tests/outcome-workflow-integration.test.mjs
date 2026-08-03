import assert from "node:assert/strict";
import { it } from "node:test";
import {
  BASELINE_FANOUT_SCHEMA,
  GEPA_CONTROLLER_SCHEMA,
  METHOD_LADDER_INPUT_SCHEMA,
  executeBaselineFanout,
  planBaselineFanout,
  recommendMethod,
  runGepaHillclimb,
  sha256OutcomeExecutorInput,
} from "../dist/index.js";

const hash = (letter) => letter.repeat(64);
const binding = {
  source_binding_sha256: hash("a"),
  verifier_calibration_sha256: hash("b"),
  benchmark_sha256: hash("c"),
  split_manifest_sha256: hash("d"),
  train_sha256: hash("e"),
  dev_sha256: hash("f"),
  holdout_sha256: null,
};
const fuse = {
  max_concurrency: 2,
  max_metric_calls: 4,
  max_spend_usd: 4,
  max_cost_per_call_usd: 1,
  max_wallclock_ms: 10_000,
  max_episodes: 4,
  max_reflections: 4,
};
const devRows = [
  { id: "d1", split: "dev", family: "direct", frozen: false },
  { id: "d2", split: "dev", family: "unmatched", frozen: false },
];
const incumbent = { candidate_id: "incumbent", candidate_sha256: hash("1") };
const seed = { candidate_id: "student-seed", candidate_sha256: hash("2") };

function receipts(context, direct, unmatched) {
  return [
    { row_id: "d1", family: "direct", metric: direct },
    { row_id: "d2", family: "unmatched", metric: unmatched },
  ].map((row) => {
    const body = {
      controller_sha256: context.controller_sha256,
      candidate_sha256: context.candidate.candidate_sha256,
      wave: context.wave,
      dev_sha256: context.dev_sha256,
      verifier_calibration_sha256: context.verifier_calibration_sha256,
      ...row,
      status: "ok",
    };
    return { ...body, receipt_sha256: sha256OutcomeExecutorInput(body) };
  });
}

it("runs the provider-free outcome-first dev loop and stops at target without holdout or promotion", async () => {
  const baselinePlan = planBaselineFanout({
    schema_version: BASELINE_FANOUT_SCHEMA,
    run_id: "outcome-audit-baseline",
    workload_id: "synthetic-outcome",
    ...binding,
    rows: devRows,
    candidates: [seed],
    incumbent,
    protected_families: [
      { family: "direct", target_score: 0.8, max_regression: 0 },
      { family: "unmatched", target_score: 1, max_regression: 0 },
    ],
    target_score: 0.95,
    fuse,
  });
  const baseline = await executeBaselineFanout(baselinePlan, async (candidate, row) => ({
    status: "ok",
    metric: candidate.candidate_id === "incumbent" ? (row.family === "direct" ? 0.8 : 1) : (row.family === "direct" ? 0.82 : 1),
    cost_usd: 0,
    latency_ms: 1,
  }));
  assert.equal(baseline.state, "completed");
  assert.equal(baseline.target_candidate_id, null);

  const gepa = await runGepaHillclimb({
    input: {
      schema_version: GEPA_CONTROLLER_SCHEMA,
      run_id: "outcome-audit-gepa",
      workload_id: "synthetic-outcome",
      ...binding,
      train_rows: [{ id: "t1", split: "train", family: "direct", frozen: false }],
      dev_rows: devRows,
      seed,
      seed_dev_quality: 0.91,
      seed_family_scores: { direct: 0.82, unmatched: 1 },
      protected_families: [
        { family: "direct", target_score: 0.8, max_regression: 0 },
        { family: "unmatched", target_score: 1, max_regression: 0 },
      ],
      target_score: 0.95,
      fuse,
    },
    verifyEvaluationReceipt: () => true,
    propose: async () => ({ status: "ok", candidate: { candidate_id: "student-optimized", candidate_sha256: hash("3") }, cost_usd: 0, latency_ms: 1 }),
    evaluate: async (context) => ({ status: "ok", rows: receipts(context, 0.9, 1), cost_usd: 0, latency_ms: 1 }),
  });
  assert.equal(gepa.state, "target_reached");
  assert.equal(gepa.best_dev_quality, 0.95);
  assert.equal(gepa.spend_usd, 0);

  const baselineReceipt = hash("4");
  const optimizedReceipt = hash("5");
  const ladderBinding = {
    source_binding_sha256: binding.source_binding_sha256,
    verifier_sha256: binding.verifier_calibration_sha256,
    benchmark_sha256: binding.benchmark_sha256,
    split_manifest_sha256: binding.split_manifest_sha256,
  };
  const recommendation = recommendMethod({
    schema_version: METHOD_LADDER_INPUT_SCHEMA,
    target_score: 0.95,
    baseline: { ...ladderBinding, receipt_sha256: baselineReceipt, split: "dev", aggregate_score: 0.91, family_scores: { direct: 0.82, unmatched: 1 } },
    optimized: { ...ladderBinding, receipt_sha256: optimizedReceipt, split: "dev", aggregate_score: 0.95, family_scores: { direct: 0.9, unmatched: 1 } },
    expected_receipt_hashes: { baseline: baselineReceipt, optimized: optimizedReceipt },
    verifier_trust: { ...ladderBinding, receipt_sha256: hash("6"), status: "pass", trusted: true },
    difficulty: { ...ladderBinding, receipt_sha256: hash("7"), status: "sufficient", headroom_rows: 2, frontier_also_fails: false },
    arm_evidence: { ...ladderBinding, receipt_sha256: hash("8"), status: "pass" },
    serving_parity: { ...ladderBinding, receipt_sha256: hash("9"), status: "pass" },
    protected_families: [
      { family: "direct", target_score: 0.8, max_regression: 0 },
      { family: "unmatched", target_score: 1, max_regression: 0 },
    ],
    budget: {
      remaining_usd: 0,
      rungs: {
        gepa: { available: true, exhausted: false, cost_usd: 0, expected_gain: 0 },
        sft: { available: false, exhausted: false, cost_usd: 0, expected_gain: 0 },
        dpo: { available: false, exhausted: false, cost_usd: 0, expected_gain: 0 },
        grpo: { available: false, exhausted: false, cost_usd: 0, expected_gain: 0 },
      },
    },
  });
  assert.equal(recommendation.outcome, "target_met");
  assert.ok(!JSON.stringify(recommendation).includes("promot"));
  assert.equal(binding.holdout_sha256, null);
});
