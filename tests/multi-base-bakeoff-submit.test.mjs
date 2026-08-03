import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validate as validateAgainst } from "../experiments/multi-base-bakeoff/validate-schema.mjs";
import {
  buildSubmitRequest,
  candidatePolicy,
  idempotencyKey,
  policySha256,
} from "../experiments/multi-base-bakeoff/submit-payload.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL(
      "../experiments/multi-base-bakeoff/contracts/experiment-executor-submit-request.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = (value) => validateAgainst(schema, value);

function submit(overrides = {}) {
  return buildSubmitRequest({
    experimentId: "bakeoff.multi-base.v1",
    candidateId: "qwen3.5-9b.sft",
    executor: "fixture",
    model: "Qwen/Qwen3.5-9B",
    renderer: "qwen3_5_disable_thinking",
    rung: "sft",
    hyperparameters: { lora_rank: 32, epochs: 3 },
    checkpoint: "tinker://example:train:0/sampler_weights/final",
    verifierRevision: "automationbench-offline@v2",
    limits: {
      budget_usd: 25,
      max_concurrent_candidates: 3,
      max_concurrent_requests_per_candidate: 8,
      max_rollouts: 2000,
      max_runtime_seconds: 7200,
    },
    ...overrides,
  });
}

test("bake-off candidates validate against understudy.executor-submit.v1", () => {
  const request = submit();
  const { valid, errors } = validate(request);
  assert.ok(valid, errors.join("; "));
  assert.equal(request.schema_version, "understudy.executor-submit.v1");
});

test("the sealed holdout is structurally absent from a submit payload", () => {
  const request = submit();
  assert.deepEqual(Object.keys(request.splits).sort(), [
    "dev_manifest_ref",
    "dev_manifest_sha256",
    "train_manifest_ref",
    "train_manifest_sha256",
  ]);
  assert.ok(!JSON.stringify(request).includes("holdout"));
});

test("the payload carries refs and hashes, never policy contents or weights", () => {
  const request = submit();
  const encoded = JSON.stringify(request);
  const policy = candidatePolicy({
    model: "Qwen/Qwen3.5-9B",
    renderer: "qwen3_5_disable_thinking",
    rung: "sft",
    hyperparameters: { lora_rank: 32, epochs: 3 },
    checkpoint: "tinker://example:train:0/sampler_weights/final",
  });
  assert.equal(request.candidate.policy_sha256, policySha256(policy));
  assert.ok(!encoded.includes(policy.system));
  assert.ok(!encoded.includes("api_search"));
  assert.match(request.candidate.policy_ref, /^understudy:\/\/policy\//);
});

test("the policy hash separates candidates that serve differently", () => {
  const base = { model: "Qwen/Qwen3.5-9B", renderer: "qwen3_5_disable_thinking", rung: "sft" };
  const digest = policySha256(candidatePolicy(base));
  assert.notEqual(digest, policySha256(candidatePolicy({ ...base, renderer: "qwen3_5" })));
  assert.notEqual(digest, policySha256(candidatePolicy({ ...base, rung: "grpo" })));
  assert.notEqual(digest, policySha256(candidatePolicy({ ...base, model: "Qwen/Qwen3.6-27B" })));
  assert.equal(digest, policySha256(candidatePolicy({ ...base })));
});

test("the idempotency key is exactly (experiment, candidate, attempt)", () => {
  const first = submit();
  const key = idempotencyKey(first);
  // A retry of the same attempt must reach the existing job, even though the
  // rest of the payload is rebuilt from scratch.
  assert.equal(key, idempotencyKey(submit()));
  assert.notEqual(key, idempotencyKey(submit({ attempt: 1 })));
  assert.notEqual(key, idempotencyKey(submit({ candidateId: "qwen3.6-27b.sft" })));
  assert.notEqual(key, idempotencyKey(submit({ experimentId: "bakeoff.multi-base.v2" })));
});

test("every executor lane the bake-off can target is accepted", () => {
  for (const executor of ["fixture", "fireworks", "modal", "wafer", "spark"]) {
    const { valid, errors } = validate(submit({ executor }));
    assert.ok(valid, `${executor}: ${errors.join("; ")}`);
  }
  // Tinker is reached through a local OpenAI-compatible shim, not as an
  // executor lane of its own; the schema must reject it.
  assert.equal(validate(submit({ executor: "tinker" })).valid, false);
});
