import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { validateAgainstSchema } from "../scripts/oee-submit-schema-validator.mjs";

const repoRoot = resolve(".");
const payloadPath = resolve("experiments/on-event-execution/contracts/candidate-submit.json");
const idempotencyPath = resolve("experiments/on-event-execution/contracts/idempotency-receipt.json");
const policyPath = resolve("experiments/on-event-execution/contracts/dpo-policy.json");
const freezePath = resolve("outputs/oee/fixture-freeze.json");
const schemaPath = resolve("schemas/understudy.executor-submit.v1.schema.json");
const holdoutSha256 = "ff1438e7c257bb39a8880220b8d2c1787f360d01010f7b1d39f960fa58aed868";

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoHoldout(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoHoldout(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      assert.equal(value.toLowerCase().includes("holdout"), false, `${path} contains holdout`);
      assert.equal(value.includes(holdoutSha256), false, `${path} contains the frozen holdout hash`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(key.toLowerCase().includes("holdout"), false, `${path} has holdout field`);
    assertNoHoldout(child, `${path}.${key}`);
  }
}

execFileSync(process.execPath, ["scripts/oee-executor-submit.mjs"], { cwd: repoRoot, stdio: "ignore" });

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const freeze = JSON.parse(readFileSync(freezePath, "utf8"));
const idempotency = JSON.parse(readFileSync(idempotencyPath, "utf8"));

test("generated payload validates against the vendored canonical schema", () => {
  assert.equal(validateAgainstSchema(payload, schema), true);
});

test("payload is refs-and-hashes only and structurally excludes holdout", () => {
  assertNoHoldout(payload);
  assert.equal(payload.candidate.policy_sha256, sha256(canonicalJson(policy)));
  assert.equal(payload.workload.dataset_manifest_sha256, sha256(readFileSync(freezePath)));
  assert.equal(payload.workload.verifier_revision, freeze.fixture.fixture_sha256);
  assert.equal(payload.splits.train_manifest_sha256, freeze.fixture.train_sha256);
  assert.equal(payload.splits.dev_manifest_sha256, freeze.fixture.dev_sha256);
  assert.equal(payload.candidate.executor, "fixture");
  assert.match(payload.candidate.model_revision, /^tinker:\/\//);
  assert.ok(payload.candidate.model_revision.length <= 240);
});

test("idempotency key is deterministic and attempt-sensitive", () => {
  const identity = {
    experiment_id: idempotency.experiment_id,
    candidate_id: idempotency.candidate_id,
    attempt: idempotency.attempt,
  };
  assert.equal(idempotency.idempotency_key, sha256(canonicalJson(identity)));
  assert.notEqual(
    idempotency.idempotency_key,
    sha256(canonicalJson({ ...identity, attempt: identity.attempt + 1 })),
  );
});

test("schema validator rejects an extra property", () => {
  const invalid = clone(payload);
  invalid.candidate.extra = true;
  assert.throws(() => validateAgainstSchema(invalid, schema), /additional property/);
});

test("schema validator rejects a bad hash pattern", () => {
  const invalid = clone(payload);
  invalid.candidate.policy_sha256 = "not-a-sha256";
  assert.throws(() => validateAgainstSchema(invalid, schema), /pattern/);
});

test("schema validator rejects a missing required field", () => {
  const invalid = clone(payload);
  delete invalid.splits.dev_manifest_sha256;
  assert.throws(() => validateAgainstSchema(invalid, schema), /missing required property/);
});

test("schema validator fails closed on an unsupported schema keyword", () => {
  const unsupportedSchema = clone(schema);
  unsupportedSchema.unevaluatedProperties = false;
  assert.throws(() => validateAgainstSchema(payload, unsupportedSchema), /unsupported schema keyword/);
});
