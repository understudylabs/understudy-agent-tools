#!/usr/bin/env node

// Emits the analyzer candidate payload for `understudy.executor-submit.v1`
// (upstream platform contract at commit c299ca4,
// services/train-api/contracts/generated/experiment-executor-submit-request.json).
//
// Refs and hashes only: no prompts, completions, labels, weights, or credentials.
// The holdout is structurally absent from this payload by contract, which matches
// the fixture's own fail-closed holdout gate.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ANALYZER_FIXTURE,
  analyzerFixtureSha256,
  analyzerSplitSha256,
  canonicalJson,
} from "../dist/analyzer-slice.js";

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const result = process.argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
};

const experimentId = arg("--experiment-id", "analyzer-bounded-verdict-dpo");
const candidateId = arg("--candidate-id", "analyzer-dpo-beta0.1-epochs3-lora32");
const executor = arg("--executor", "fixture");
const model = arg("--model", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16");
const modelRevision = arg("--model-revision", null);
const verifierRevision = arg("--verifier-revision");
const pairsRef = arg("--pairs-ref");
const pairsSha256 = arg("--pairs-sha256");
const attempt = Number(arg("--attempt", "0"));
const outPath = arg("--out");

if (!verifierRevision) throw new Error("--verifier-revision is required (the commit that pins the verifier)");
if (!pairsRef || !pairsSha256) throw new Error("--pairs-ref and --pairs-sha256 are required");
if (!/^[a-f0-9]{64}$/.test(pairsSha256)) throw new Error("--pairs-sha256 must be a lowercase sha256 hex digest");
if (!Number.isInteger(attempt) || attempt < 0) throw new Error("--attempt must be a non-negative integer");
if (/holdout/i.test(`${pairsRef} ${pairsSha256} ${verifierRevision}`)) {
  throw new Error("refusing to emit a submit payload that references the sealed holdout");
}

// The candidate policy is the training recipe plus the content-addressed pair set.
// It is hashed, never inlined, so the payload carries a reference and a digest only.
export const analyzerDpoPolicy = {
  method: "dpo",
  beta: 0.1,
  epochs: 3,
  lora_rank: 32,
  renderer: "nemotron3",
  base_model: model,
  pairs_ref: pairsRef,
  pairs_sha256: pairsSha256,
  mined_from_split: "train",
};

const policySha256 = createHash("sha256").update(canonicalJson(analyzerDpoPolicy)).digest("hex");

const payload = {
  schema_version: "understudy.executor-submit.v1",
  experiment_id: experimentId,
  candidate: {
    candidate_id: candidateId,
    executor,
    model,
    ...(modelRevision ? { model_revision: modelRevision } : {}),
    policy_ref: `analyzer/policy/${candidateId}.json`,
    policy_sha256: policySha256,
  },
  attempt,
  workload: {
    id: "analyzer",
    dataset_manifest_ref: `analyzer/fixture/${ANALYZER_FIXTURE.fixture_id}.json`,
    dataset_manifest_sha256: analyzerFixtureSha256(),
    verifier_environment: ANALYZER_FIXTURE.fixture_id,
    verifier_revision: verifierRevision,
  },
  splits: {
    train_manifest_ref: `analyzer/splits/${ANALYZER_FIXTURE.fixture_id}.train.json`,
    train_manifest_sha256: analyzerSplitSha256("train"),
    dev_manifest_ref: `analyzer/splits/${ANALYZER_FIXTURE.fixture_id}.dev.json`,
    dev_manifest_sha256: analyzerSplitSha256("dev"),
  },
  limits: {
    budget_usd: Number(arg("--budget-usd", "25")),
    max_concurrent_candidates: Number(arg("--max-concurrent-candidates", "1")),
    max_concurrent_requests_per_candidate: Number(arg("--max-concurrent-requests", "4")),
    max_rollouts: Number(arg("--max-rollouts", "1000")),
    max_runtime_seconds: Number(arg("--max-runtime-seconds", "7200")),
  },
};

// Fail closed rather than emit a payload that could carry sealed-split material.
const holdoutSha256 = analyzerSplitSha256("holdout");
const serialized = JSON.stringify(payload);
if (serialized.includes(holdoutSha256) || /holdout/i.test(serialized)) {
  throw new Error("refusing to emit a submit payload that references the sealed holdout");
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
}
console.log(JSON.stringify(payload, null, 2));
