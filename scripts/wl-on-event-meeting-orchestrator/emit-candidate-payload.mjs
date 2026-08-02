#!/usr/bin/env node
/**
 * Emit an immutable understudy.executor-submit.v1 candidate payload.
 *
 * This is a contract/verifier artifact only. It never contacts a provider,
 * starts a controller, queues work, or polls a run.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  FROZEN_FIXTURE_SHA256,
  MEETING_ORCHESTRATOR_SUBSET,
} from "../../dist/workloads/on-event-meeting-orchestrator/offline.js";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
function integerArg(name, fallback) {
  const value = Number(argValue(name, String(fallback)));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function sha256Json(value) {
  return createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
}

const experimentId = argValue("--experiment-id");
const candidateId = argValue("--candidate-id");
const model = argValue("--model", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16");
const modelRevision = argValue("--model-revision");
const policyRef = argValue("--policy-ref", "artifact://wl-on-event-meeting-orchestrator/tuned-policy.json");
const pairsPath = argValue("--normalized-pairs");
const trainReceiptPath = argValue("--train-receipt");
const datasetManifestPath = resolve(argValue(
  "--dataset-manifest",
  "outputs/wl-on-event-meeting-orchestrator/freeze.json",
));
const outPath = argValue("--out", "outputs/wl-on-event-meeting-orchestrator/candidate-payload.json");
const receiptPath = argValue("--receipt", `${outPath}.receipt.json`);
const attempt = integerArg("--attempt", 0);
if (!experimentId || !candidateId || !modelRevision || !pairsPath || !trainReceiptPath) {
  throw new Error("--experiment-id, --candidate-id, --model-revision, --normalized-pairs, and --train-receipt are required");
}
if (attempt < 0) throw new Error("--attempt must be non-negative");

const normalizedPairsSha256 = sha256File(pairsPath);
const trainReceiptSha256 = sha256File(trainReceiptPath);
const datasetManifestSha256 = sha256File(datasetManifestPath);
const policyDescriptor = {
  beta: Number(argValue("--beta", "0.1")),
  epochs: integerArg("--epochs", 3),
  lora_rank: integerArg("--lora-rank", 32),
  renderer: argValue("--renderer", "nemotron3"),
  normalized_pairs_sha256: normalizedPairsSha256,
  train_receipt_sha256: trainReceiptSha256,
};
const policySha256 = sha256Json(policyDescriptor);
const idempotencyKey = sha256Json({ experiment_id: experimentId, candidate_id: candidateId, attempt });

const payload = {
  schema_version: "understudy.executor-submit.v1",
  experiment_id: experimentId,
  candidate: {
    candidate_id: candidateId,
    executor: "fixture",
    model,
    model_revision: modelRevision,
    policy_ref: policyRef,
    policy_sha256: policySha256,
  },
  attempt,
  workload: {
    id: "on-event-meeting-orchestrator",
    dataset_manifest_ref: `fixture://${MEETING_ORCHESTRATOR_SUBSET.fixture_id}/freeze.json`,
    dataset_manifest_sha256: datasetManifestSha256,
    verifier_environment: MEETING_ORCHESTRATOR_SUBSET.fixture_id,
    verifier_revision: FROZEN_FIXTURE_SHA256,
  },
  splits: {
    train_manifest_ref: `fixture://${MEETING_ORCHESTRATOR_SUBSET.fixture_id}/train`,
    dev_manifest_ref: `fixture://${MEETING_ORCHESTRATOR_SUBSET.fixture_id}/dev`,
  },
  limits: {
    budget_usd: Number(argValue("--budget-usd", "0")),
    max_concurrent_candidates: integerArg("--max-concurrent-candidates", 1),
    max_concurrent_requests_per_candidate: integerArg("--max-concurrent-requests", 4),
    max_rollouts: integerArg("--max-rollouts", 96),
    max_runtime_seconds: integerArg("--max-runtime-seconds", 86400),
  },
};
const receipt = {
  schema_version: "understudy.executor-submit.receipt.v1",
  idempotency_key: idempotencyKey,
  experiment_id: experimentId,
  candidate_id: candidateId,
  attempt,
  policy_descriptor: policyDescriptor,
  payload_sha256: sha256Json(payload),
};

mkdirSync(dirname(outPath), { recursive: true });
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ payload, receipt, out: outPath, receipt_path: receiptPath }, null, 2));
