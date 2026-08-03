import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { METHOD_LADDER_INPUT_SCHEMA, recommendMethod, sha256 } from "../dist/method-ladder/index.js";

const a = "a".repeat(64);
const b = "b".repeat(64);
const binding = {
  source_binding_sha256: a,
  verifier_sha256: a,
  benchmark_sha256: a,
  split_manifest_sha256: a,
};

function input(overrides = {}) {
  return {
    schema_version: METHOD_LADDER_INPUT_SCHEMA,
    target_score: 0.9,
    baseline: { ...binding, receipt_sha256: a, split: "dev", aggregate_score: 0.7, family_scores: { direct: 0.8, unmatched: 1 } },
    optimized: { ...binding, receipt_sha256: b, split: "dev", aggregate_score: 0.8, family_scores: { direct: 0.85, unmatched: 1 } },
    expected_receipt_hashes: { baseline: a, optimized: b },
    verifier_trust: { ...binding, receipt_sha256: a, status: "pass", trusted: true },
    difficulty: { ...binding, receipt_sha256: a, status: "sufficient", headroom_rows: 20, frontier_also_fails: false },
    arm_evidence: { ...binding, receipt_sha256: a, status: "pass" },
    serving_parity: { ...binding, receipt_sha256: a, status: "pass" },
    protected_families: [
      { family: "direct", target_score: 0.85, max_regression: 0 },
      { family: "unmatched", target_score: 1, max_regression: 0 },
    ],
    budget: {
      remaining_usd: 100,
      rungs: {
        gepa: { available: true, exhausted: false, cost_usd: 20, expected_gain: 0.15 },
        sft: { available: true, exhausted: false, cost_usd: 60, expected_gain: 0.25 },
        dpo: { available: true, exhausted: false, cost_usd: 70, expected_gain: 0.2 },
        grpo: { available: true, exhausted: false, cost_usd: 90, expected_gain: 0.3 },
      },
    },
    ...overrides,
  };
}

describe("generic outcome-first method ladder", () => {
  it("continues GEPA when it is the first plausible rung", () => {
    assert.equal(recommendMethod(input()).outcome, "continue_gepa");
  });

  it("escalates to SFT after GEPA is explicitly exhausted", () => {
    const value = input();
    value.budget.rungs.gepa.exhausted = true;
    assert.equal(recommendMethod(value).outcome, "escalate_sft");
  });

  it("reports target_met without promotion vocabulary", () => {
    const value = input({ target_score: 0.8 });
    const recommendation = recommendMethod(value);
    assert.equal(recommendation.outcome, "target_met");
    assert.ok(!JSON.stringify(recommendation).includes("promot"));
  });

  it("rejects unknown and holdout-shaped input", () => {
    assert.throws(() => recommendMethod({ ...input(), unknown: true }));
    assert.throws(() => recommendMethod({ ...input(), holdout: { status: "sealed_not_run" } }));
    assert.throws(() => recommendMethod({ ...input(), optimized: { ...input().optimized, split: "holdout" } }));
  });

  it("fails closed on every binding mismatch", () => {
    for (const key of Object.keys(binding)) {
      const value = input();
      value.serving_parity = { ...value.serving_parity, [key]: b };
      assert.equal(recommendMethod(value).outcome, "blocked", key);
    }
  });

  it("fails closed on trust, parity, arm, and difficulty gates", () => {
    for (const mutate of [
      (value) => { value.verifier_trust.trusted = false; },
      (value) => { value.serving_parity.status = "fail"; },
      (value) => { value.arm_evidence.status = "fail"; },
      (value) => { value.difficulty.status = "insufficient"; },
    ]) {
      const value = input();
      mutate(value);
      assert.equal(recommendMethod(value).outcome, "blocked");
    }
  });

  it("requires every protected family and refuses regression", () => {
    const missing = input();
    delete missing.optimized.family_scores.unmatched;
    assert.equal(recommendMethod(missing).outcome, "blocked");

    const regressed = input();
    regressed.optimized.family_scores.direct = 0.7;
    assert.equal(recommendMethod(regressed).outcome, "blocked");
  });

  it("blocks when every rung is exhausted, unavailable, underpowered, or over budget", () => {
    const value = input({ budget: {
      remaining_usd: 10,
      rungs: {
        gepa: { available: true, exhausted: true, cost_usd: 1, expected_gain: 1 },
        sft: { available: false, exhausted: false, cost_usd: 1, expected_gain: 1 },
        dpo: { available: true, exhausted: false, cost_usd: 20, expected_gain: 1 },
        grpo: { available: true, exhausted: false, cost_usd: 1, expected_gain: 0.01 },
      },
    } });
    assert.equal(recommendMethod(value).outcome, "blocked");
  });

  it("uses canonical hashes independent of key order", () => {
    assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
  });
});
