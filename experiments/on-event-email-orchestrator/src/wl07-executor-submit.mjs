import { createHash } from "node:crypto";

const EXECUTORS = new Set(["modal", "wafer", "fireworks", "spark", "fixture"]);

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value, name) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase sha256`);
  }
  return value;
}

function rejectHoldoutKeys(value, path = "input") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/holdout/i.test(key)) {
      throw new TypeError(`${path}.${key} is not allowed in executor-submit.v1`);
    }
    rejectHoldoutKeys(child, `${path}.${key}`);
  }
}

export function executorSubmitIdempotencyKey({
  experimentId,
  candidateId,
  attempt,
}) {
  requireString(experimentId, "experimentId");
  requireString(candidateId, "candidateId");
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1000) {
    throw new TypeError("attempt must be an integer from 0 through 1000");
  }
  return createHash("sha256")
    .update(JSON.stringify([experimentId, candidateId, attempt]))
    .digest("hex");
}

export function buildExecutorSubmitPayload(input) {
  if (!input || typeof input !== "object") throw new TypeError("input is required");
  rejectHoldoutKeys(input);
  const {
    experimentId,
    candidateId,
    executor,
    model,
    modelRevision,
    policyRef,
    policySha256,
    workloadId,
    datasetManifestRef,
    datasetManifestSha256,
    verifierEnvironment,
    verifierRevision,
    trainManifestRef,
    devManifestRef,
    budgetUsd,
    maxConcurrentCandidates,
    maxConcurrentRequestsPerCandidate,
    maxRollouts,
    maxRuntimeSeconds,
    attempt,
  } = input;
  requireString(experimentId, "experimentId");
  requireString(candidateId, "candidateId");
  if (!EXECUTORS.has(executor)) {
    throw new TypeError(`executor must be one of ${[...EXECUTORS].join(", ")}`);
  }
  requireString(model, "model");
  requireString(policyRef, "policyRef");
  requireSha256(policySha256, "policySha256");
  requireString(workloadId, "workloadId");
  requireString(datasetManifestRef, "datasetManifestRef");
  requireSha256(datasetManifestSha256, "datasetManifestSha256");
  requireString(verifierEnvironment, "verifierEnvironment");
  requireString(verifierRevision, "verifierRevision");
  requireString(trainManifestRef, "trainManifestRef");
  requireString(devManifestRef, "devManifestRef");
  if (modelRevision !== undefined) requireString(modelRevision, "modelRevision");
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > 1000) {
    throw new TypeError("attempt must be an integer from 0 through 1000");
  }
  for (const [value, name] of [
    [budgetUsd, "budgetUsd"],
    [maxConcurrentCandidates, "maxConcurrentCandidates"],
    [maxConcurrentRequestsPerCandidate, "maxConcurrentRequestsPerCandidate"],
    [maxRollouts, "maxRollouts"],
    [maxRuntimeSeconds, "maxRuntimeSeconds"],
  ]) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative number`);
    }
  }
  return {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: experimentId,
    candidate: {
      candidate_id: candidateId,
      executor,
      model,
      ...(modelRevision === undefined ? {} : { model_revision: modelRevision }),
      policy_ref: policyRef,
      policy_sha256: policySha256,
    },
    attempt,
    workload: {
      id: workloadId,
      dataset_manifest_ref: datasetManifestRef,
      dataset_manifest_sha256: datasetManifestSha256,
      verifier_environment: verifierEnvironment,
      verifier_revision: verifierRevision,
    },
    splits: {
      train_manifest_ref: trainManifestRef,
      dev_manifest_ref: devManifestRef,
    },
    limits: {
      budget_usd: budgetUsd,
      max_concurrent_candidates: maxConcurrentCandidates,
      max_concurrent_requests_per_candidate: maxConcurrentRequestsPerCandidate,
      max_rollouts: maxRollouts,
      max_runtime_seconds: maxRuntimeSeconds,
    },
  };
}

export const EXECUTOR_SUBMIT_EXECUTORS = [...EXECUTORS];
