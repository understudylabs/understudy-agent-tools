import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { submitPayload } from "../experiments/workload-orchestrator/submit-payload.mjs";

/** The `understudy.executor-submit.v1` surface, asserted without provider calls. */
const REQUIRED = {
  root: ["schema_version", "experiment_id", "candidate", "attempt", "workload", "splits", "limits"],
  candidate: ["candidate_id", "executor", "model", "policy_ref", "policy_sha256"],
  workload: ["id", "dataset_manifest_ref", "dataset_manifest_sha256", "verifier_environment", "verifier_revision"],
  splits: ["train_manifest_ref", "dev_manifest_ref"],
  limits: [
    "budget_usd",
    "max_concurrent_candidates",
    "max_concurrent_requests_per_candidate",
    "max_rollouts",
    "max_runtime_seconds",
  ],
};
const EXECUTORS = new Set(["modal", "wafer", "fireworks", "spark", "fixture"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

describe("WL-OR candidate submit payload", () => {
  const payload = submitPayload({ experimentId: "wl-or-orchestrator-repair", attempt: 0 });

  it("carries exactly the contract's fields", () => {
    for (const [section, keys] of Object.entries(REQUIRED)) {
      const object = section === "root" ? payload : payload[section];
      assert.deepEqual(Object.keys(object).sort(), [...keys, ...(section === "candidate" ? ["model_revision"] : [])].sort());
    }
    assert.equal(payload.schema_version, "understudy.executor-submit.v1");
    assert.ok(ID.test(payload.experiment_id) && ID.test(payload.candidate.candidate_id) && ID.test(payload.workload.id));
    assert.ok(EXECUTORS.has(payload.candidate.executor));
    assert.ok(SHA256.test(payload.candidate.policy_sha256) && SHA256.test(payload.workload.dataset_manifest_sha256));
    assert.ok(Number.isInteger(payload.attempt) && payload.attempt >= 0);
  });

  it("leaves the sealed holdout structurally absent", () => {
    assert.ok(!/holdout/i.test(JSON.stringify(payload)));
  });

  it("passes refs and hashes, never weights, secrets, or raw rows", () => {
    const serialized = JSON.stringify(payload);
    assert.ok(!/tinker:\/\//.test(serialized), "a checkpoint URI belongs in the hashed policy descriptor, not the payload");
    assert.ok(!/(api[_-]?key|authorization|bearer|password|token)/i.test(serialized));
    assert.ok(!/prompt|completion|assistant/i.test(serialized));
  });

  it("is byte-identical for the same (experiment, candidate, attempt)", () => {
    const again = submitPayload({ experimentId: "wl-or-orchestrator-repair", attempt: 0 });
    assert.equal(JSON.stringify(again), JSON.stringify(payload));
    const retry = submitPayload({ experimentId: "wl-or-orchestrator-repair", attempt: 1 });
    assert.equal(retry.candidate.policy_sha256, payload.candidate.policy_sha256);
    assert.notEqual(retry.attempt, payload.attempt);
  });
});
