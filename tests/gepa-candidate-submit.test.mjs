import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ExperimentSubmitRequestSchema,
} from "../dist/experiment-executor.js";
import {
  buildCandidateSubmitRequest,
  emitCandidateSubmitRequest,
} from "../dist/gepa-candidate-submit.js";

const submitSchema = JSON.parse(
  readFileSync("schemas/understudy.executor-submit.v1.schema.json", "utf8"),
);

function candidate() {
  return {
    candidate_id: "c4",
    policy_sha256: "a".repeat(64),
    fixture: "synthetic-fixture",
    fixture_sha256: "b".repeat(64),
    train_split_sha256: "c".repeat(64),
    dev_split_sha256: "d".repeat(64),
    gepa_config: {
      model: "model-a",
      concurrency: 8,
      max_rollouts: 600,
    },
  };
}

test("emitter output validates against the vendored submit schema", () => {
  const payload = buildCandidateSubmitRequest(candidate());
  assert.equal(payload.schema_version, submitSchema.properties.schema_version.const);
  ExperimentSubmitRequestSchema.parse(payload);

  const emitted = emitCandidateSubmitRequest(
    "outputs/gepa-run/candidate.json",
    "/tmp/understudy-candidate-submit.json",
    { model: "model-a" },
  );
  ExperimentSubmitRequestSchema.parse(emitted);
  assert.equal(emitted.candidate.executor, "fixture");
  assert.match(emitted.candidate.policy_sha256, /^[a-f0-9]{64}$/);
  assert.match(emitted.splits.train_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(emitted.splits.dev_manifest_sha256, /^[a-f0-9]{64}$/);
});

test("holdout-bearing payloads are rejected by the incumbent schema", () => {
  const payload = buildCandidateSubmitRequest(candidate());
  const holdoutPayload = {
    ...payload,
    splits: {
      ...payload.splits,
      holdout_manifest_ref: "fixture://synthetic-fixture/holdout/hash",
    },
  };
  assert.throws(
    () => ExperimentSubmitRequestSchema.parse(holdoutPayload),
    /Unrecognized key|unrecognized key/i,
  );
});

test("candidate submit payload contains refs and hashes, not raw content", () => {
  const encoded = JSON.stringify(buildCandidateSubmitRequest(candidate()));
  assert.equal(encoded.includes("raw prompt text"), false);
  assert.equal(encoded.includes("trace contents"), false);
  assert.equal(encoded.includes("secret"), false);
  assert.equal(encoded.includes("holdout"), false);
});
