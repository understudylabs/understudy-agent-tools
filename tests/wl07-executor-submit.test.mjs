import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  buildExecutorSubmitPayload,
  executorSubmitIdempotencyKey,
} from "../experiments/on-event-email-orchestrator/src/wl07-executor-submit.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const input = {
  experimentId: "wl07-dpo-dev",
  candidateId: "nemotron3-dpo",
  executor: "fixture",
  model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
  modelRevision: "nemotron3",
  policyRef: "artifact://wl07/dpo/receipt.json",
  policySha256: sha("policy"),
  workloadId: "on-event-email-orchestrator",
  datasetManifestRef: "artifact://wl07/fixture-manifest.json",
  datasetManifestSha256: sha("fixture"),
  verifierEnvironment: "automationbench-offline",
  verifierRevision: "wl07-email-orchestration-offline-v1",
  trainManifestRef: "artifact://wl07/train-manifest.json",
  devManifestRef: "artifact://wl07/dev-manifest.json",
  budgetUsd: 10,
  maxConcurrentCandidates: 1,
  maxConcurrentRequestsPerCandidate: 1,
  maxRollouts: 48,
  maxRuntimeSeconds: 3600,
  attempt: 0,
};

describe("WL-07 executor-submit contract", () => {
  it("builds a schema-shaped refs-and-hashes payload", () => {
    const payload = buildExecutorSubmitPayload(input);
    assert.equal(payload.schema_version, "understudy.executor-submit.v1");
    assert.deepEqual(Object.keys(payload.splits).sort(), ["dev_manifest_ref", "train_manifest_ref"]);
    assert.equal("holdout" in payload, false);
    assert.equal("holdout_manifest_ref" in payload.splits, false);
    assert.match(payload.candidate.policy_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(payload).sort(), [
      "attempt", "candidate", "experiment_id", "limits", "schema_version", "splits", "workload",
    ]);
  });

  it("requires an explicit allowed executor and supports an enum value", () => {
    assert.equal(buildExecutorSubmitPayload(input).candidate.executor, "fixture");
    assert.throws(() => buildExecutorSubmitPayload({ ...input, executor: undefined }), /executor/);
  });

  it("derives stable idempotency keys from experiment, candidate, and attempt", () => {
    assert.equal(
      executorSubmitIdempotencyKey(input),
      executorSubmitIdempotencyKey({ ...input }),
    );
    assert.notEqual(
      executorSubmitIdempotencyKey(input),
      executorSubmitIdempotencyKey({ ...input, attempt: 1 }),
    );
  });

  it("rejects a payload carrying a holdout reference", () => {
    assert.throws(
      () => buildExecutorSubmitPayload({ ...input, splits: { holdout_manifest_ref: "artifact://sealed" } }),
      /holdout.*not allowed/i,
    );
  });
});
