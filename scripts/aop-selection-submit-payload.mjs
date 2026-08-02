#!/usr/bin/env node
/**
 * Emit this arm's candidate as an `understudy.executor-submit.v1` payload.
 *
 * The aop-selection arm is a candidate-method surface, not a controller: it
 * produces one immutable, hash-addressed candidate description that the unified
 * Workflow submits. Everything crossing the boundary is a ref plus a SHA-256 —
 * no rollouts, prompts, pairs, weights, or credentials.
 *
 * The holdout is STRUCTURALLY ABSENT from this payload, as the schema requires:
 * `splits` carries train and dev manifest refs only. Holdout numbers live in the
 * sealed evaluation receipt, which is not a submit input.
 *
 * The payload is deterministic given its inputs, so it doubles as the
 * idempotency key material for (experiment_id, candidate_id, attempt): resubmit
 * with the same attempt and the bytes — and therefore the job identity — are
 * identical.
 *
 * Usage:
 *   node scripts/aop-selection-submit-payload.mjs \
 *     --receipt outputs/aop/dpo-train-receipt.json \
 *     --out experiments/aop-selection-repair/executor-submit.json
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { AOP_SELECTION_SUBSET, aopSplitSha256 } from "../dist/aop-selection-offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const receiptPath = argValue("--receipt", "outputs/aop/dpo-train-receipt.json");
const outPath = argValue("--out", "experiments/aop-selection-repair/executor-submit.json");
const experimentId = argValue("--experiment-id", "aop-selection-repair");
const candidateId = argValue("--candidate-id", "aop-selection-dpo-r2");
const attempt = Number(argValue("--attempt", "0"));

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
if (!receipt.checkpoint) throw new Error(`${receiptPath} has no checkpoint; nothing to submit`);

/**
 * The candidate policy is base weights + LoRA checkpoint + the decode settings
 * the scores were produced under. Hashing that description — not the weights —
 * is what makes two submissions comparable.
 */
const policy = {
  kind: "lora-dpo",
  base_model: receipt.base_model,
  renderer: receipt.renderer,
  checkpoint_ref: receipt.checkpoint,
  pairs_sha256: receipt.pairs_sha256,
  hyperparameters: receipt.hyperparameters,
  decode: { temperature: 0, max_tokens: 384, max_turns: 10 },
};
const policySha256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");

const payload = {
  schema_version: "understudy.executor-submit.v1",
  experiment_id: experimentId,
  candidate: {
    candidate_id: candidateId,
    executor: "fixture",
    model: receipt.base_model,
    model_revision: receipt.checkpoint,
    policy_ref: `sha256:${policySha256}`,
    policy_sha256: policySha256,
  },
  attempt,
  workload: {
    id: AOP_SELECTION_SUBSET.benchmark_id,
    dataset_manifest_ref: `fixture:${AOP_SELECTION_SUBSET.fixture_id}`,
    dataset_manifest_sha256: aopSplitSha256("train"),
    verifier_environment: `${AOP_SELECTION_SUBSET.benchmark_id}:${AOP_SELECTION_SUBSET.subset}`,
    verifier_revision: AOP_SELECTION_SUBSET.verifiers_version_pin,
  },
  splits: {
    train_manifest_ref: `fixture:${AOP_SELECTION_SUBSET.fixture_id}/train`,
    train_manifest_sha256: aopSplitSha256("train"),
    dev_manifest_ref: `fixture:${AOP_SELECTION_SUBSET.fixture_id}/dev`,
    dev_manifest_sha256: aopSplitSha256("dev"),
  },
  limits: {
    budget_usd: 25,
    max_concurrent_candidates: 1,
    max_concurrent_requests_per_candidate: 8,
    max_rollouts: 200,
    max_runtime_seconds: 5400,
  },
};

const serialized = `${JSON.stringify(payload, null, 2)}\n`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, serialized);
console.log(serialized);
