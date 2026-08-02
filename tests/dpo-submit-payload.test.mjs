import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { v2SplitSha256 } from "../dist/automationbench-v2.js";
import { buildSubmitPayload, validateAgainstSchema } from "../scripts/dpo-submit-payload.mjs";

const SCHEMA = JSON.parse(readFileSync(new URL("../schemas/understudy.executor-submit.v1.schema.json", import.meta.url), "utf8"));

const POLICY = { method: "dpo", beta: 0.1, lora_rank: 32, learning_rate: 1e-5, epochs: 2 };

function build(overrides = {}) {
  return buildSubmitPayload({
    experimentId: "automationbench-v2-dpo-2026-08",
    candidateId: "nemotron3-nano-dpo-r32",
    executor: "fixture",
    model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    policy: POLICY,
    policyRef: "file://outputs/dpo/policy.json",
    attempt: 0,
    limits: {
      budget_usd: 25,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 8,
      max_rollouts: 2000,
      max_runtime_seconds: 7200,
    },
    ...overrides,
  });
}

describe("executor submit payload", () => {
  it("validates against the published contract", () => {
    assert.deepEqual(validateAgainstSchema(SCHEMA, build()), []);
  });

  it("carries refs and hashes only — no pairs, prompts, or weights", () => {
    const text = JSON.stringify(build());
    for (const word of ["chosen", "rejected", "prompt", "api_key", "weights"]) {
      assert.ok(!text.includes(word), `payload must not mention ${word}`);
    }
  });

  it("keeps the holdout structurally absent", () => {
    const payload = build();
    assert.ok(!("holdout" in payload.splits));
    assert.ok(!JSON.stringify(payload).includes(v2SplitSha256("holdout")));
  });

  it("hashes the policy canonically, independent of key order", () => {
    const a = build({ policy: { beta: 0.1, method: "dpo" } });
    const b = build({ policy: { method: "dpo", beta: 0.1 } });
    assert.equal(a.candidate.policy_sha256, b.candidate.policy_sha256);
    assert.notEqual(a.candidate.policy_sha256, build({ policy: { method: "dpo", beta: 0.5 } }).candidate.policy_sha256);
  });

  it("is deterministic for a retry of the same attempt", () => {
    assert.deepEqual(build(), build());
  });

  it("refuses to submit when the pair gate did not pass", () => {
    assert.throws(() => build({ pairsReport: { verdict: "fail" } }), /pair gate did not pass/);
  });

  it("refuses pairs cut against a different train split", () => {
    assert.throws(() => build({ pairsReport: { verdict: "pass", train_split_sha256: "0".repeat(64) } }), /different train split/);
  });

  it("accepts a gated pair report for the current train split", () => {
    const payload = build({ pairsReport: { verdict: "pass", train_split_sha256: v2SplitSha256("train") } });
    assert.deepEqual(validateAgainstSchema(SCHEMA, payload), []);
  });

  it("rejects an executor the contract does not name", () => {
    assert.deepEqual(
      validateAgainstSchema(SCHEMA, build({ executor: "tinker" })).map((error) => error.split(":")[0]),
      ["$.candidate.executor"],
    );
  });

  it("rejects a field the contract does not define", () => {
    const payload = { ...build(), holdout_manifest_ref: "fixture://holdout" };
    assert.match(validateAgainstSchema(SCHEMA, payload).join(), /holdout_manifest_ref: not allowed/);
  });
});
