#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_RECEIPT_REF = "outputs/oee/fixture-freeze.json";
const POLICY_REF = "experiments/on-event-execution/contracts/dpo-policy.json";
const TRAIN_RECEIPT_REF = "outputs/oee/dpo/train-receipt.json";
const PAYLOAD_REF = "experiments/on-event-execution/contracts/candidate-submit.json";
const IDEMPOTENCY_REF = "experiments/on-event-execution/contracts/idempotency-receipt.json";
const EXPERIMENT_ID = "on-event-execution-repair";
const CANDIDATE_ID = "oee-dpo-nemotron3-nano-b010-e3-r32";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error(`cannot canonicalize ${typeof value}`);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
}

const attempt = Number(argValue("--attempt", "0"));
if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1000) throw new Error("--attempt must be an integer from 0 through 1000");

const fixtureReceipt = readJson(FIXTURE_RECEIPT_REF);
const policy = readJson(POLICY_REF);
const trainReceipt = readJson(TRAIN_RECEIPT_REF);
const fixture = fixtureReceipt.fixture;
if (!fixture || typeof fixture !== "object") throw new Error("fixture receipt has no fixture object");
if (policy.method !== "dpo") throw new Error("policy descriptor is not a DPO policy");
assertEqual(policy.pairs.count, trainReceipt.pairs, "policy pair count");
assertEqual(policy.pairs.sha256, "437e4fce9e5423dd5de734bdc3157d88b32071bcf9d6c6ca3f46af9f26df184a", "policy pairs sha256");
assertEqual(policy.mined_from.fixture_sha256, fixture.fixture_sha256, "policy fixture sha256");
assertEqual(policy.mined_from.train_split_sha256, fixture.train_sha256, "policy train split sha256");

const modelRevision = trainReceipt.checkpoint;
if (typeof modelRevision !== "string" || !modelRevision.startsWith("tinker://")) throw new Error("training receipt checkpoint must be a tinker:// reference");
if (modelRevision.length > 240) throw new Error("candidate.model_revision exceeds the schema maximum");

const policySha256 = sha256(canonicalJson(policy));
const fixtureManifestSha256 = sha256(readFileSync(FIXTURE_RECEIPT_REF));
const payload = {
  schema_version: "understudy.executor-submit.v1",
  experiment_id: EXPERIMENT_ID,
  candidate: {
    candidate_id: CANDIDATE_ID,
    executor: "fixture",
    model: trainReceipt.base_model,
    model_revision: modelRevision,
    policy_ref: POLICY_REF,
    policy_sha256: policySha256,
  },
  attempt,
  workload: {
    id: "on-event-execution",
    dataset_manifest_ref: FIXTURE_RECEIPT_REF,
    dataset_manifest_sha256: fixtureManifestSha256,
    verifier_environment: fixture.fixture_id,
    verifier_revision: fixture.fixture_sha256,
  },
  splits: {
    train_manifest_ref: `${FIXTURE_RECEIPT_REF}#fixture.train_sha256`,
    train_manifest_sha256: fixture.train_sha256,
    dev_manifest_ref: `${FIXTURE_RECEIPT_REF}#fixture.dev_sha256`,
    dev_manifest_sha256: fixture.dev_sha256,
  },
  limits: {
    budget_usd: 100,
    max_concurrent_candidates: 1,
    max_concurrent_requests_per_candidate: 4,
    max_rollouts: 240,
    max_runtime_seconds: 7200,
  },
};

const idempotencyInput = {
  experiment_id: EXPERIMENT_ID,
  candidate_id: CANDIDATE_ID,
  attempt,
};
const idempotencyReceipt = {
  schema_version: "understudy.executor-submit.idempotency.v1",
  ...idempotencyInput,
  idempotency_key: sha256(canonicalJson(idempotencyInput)),
  payload_ref: PAYLOAD_REF,
};

writeFileSync(PAYLOAD_REF, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(IDEMPOTENCY_REF, `${JSON.stringify(idempotencyReceipt, null, 2)}\n`);
console.log(JSON.stringify({
  payload_ref: PAYLOAD_REF,
  payload_sha256: sha256(readFileSync(PAYLOAD_REF)),
  policy_sha256: policySha256,
  idempotency_ref: IDEMPOTENCY_REF,
  idempotency_key: idempotencyReceipt.idempotency_key,
  attempt,
}, null, 2));
