#!/usr/bin/env node
/**
 * Emit a bake-off candidate as an `understudy.executor-submit.v1` payload for
 * the unified Workflow controller.
 *
 * This arm is a candidate-method surface, not an executor: it produces the
 * candidate payload and the artifact contracts, and owns no controller, queue,
 * or state of its own. Everything here is refs and hashes — the policy, the
 * dataset manifests, and the split manifests travel as sha256 digests, never as
 * trajectories, prompts, weights, or credentials.
 *
 * The holdout is structurally absent by construction: `splits` carries train
 * and dev only, and the holdout appears solely in the post-selection evidence
 * row, after the submit boundary.
 *
 *   node experiments/multi-base-bakeoff/submit-payload.mjs \
 *     --experiment-id bakeoff.multi-base.v1 --candidate-id qwen3.5-9b.sft \
 *     --executor fixture --model Qwen/Qwen3.5-9B --renderer qwen3_5_disable_thinking \
 *     --rung sft --budget-usd 25
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { v2SplitSha256, v2FixtureSha256 } from "../../dist/automationbench-v2.js";
import { CONTRACT_ID, PARAMS, SYSTEM, contractSha256, parseAction } from "./contract.mjs";

export const VERIFIER_ENVIRONMENT = "understudy.automationbench.offline";

/**
 * The candidate policy: everything that decides what the served model does,
 * hashed into one digest. Two candidates with the same digest are the same
 * policy under the same serving contract.
 */
export function candidatePolicy({ model, renderer, rung, hyperparameters = {}, checkpoint = null }) {
  return {
    contract_id: CONTRACT_ID,
    contract_sha256: contractSha256(),
    system: SYSTEM,
    params: PARAMS,
    parser: parseAction.toString(),
    model,
    renderer,
    rung,
    hyperparameters,
    // A checkpoint reference, never the weights themselves.
    checkpoint_ref: checkpoint,
  };
}

export function policySha256(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function buildSubmitRequest(options) {
  const {
    experimentId,
    candidateId,
    executor = "fixture",
    model,
    modelRevision = null,
    renderer,
    rung,
    hyperparameters = {},
    checkpoint = null,
    policyRef,
    verifierRevision,
    attempt = 0,
    limits,
  } = options;
  const policy = candidatePolicy({ model, renderer, rung, hyperparameters, checkpoint });
  const fixtureSha = v2FixtureSha256();
  const datasetRef = `understudy://fixture/${PARAMS.fixture}@${fixtureSha}`;
  return {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: experimentId,
    candidate: {
      candidate_id: candidateId,
      executor,
      model,
      ...(modelRevision ? { model_revision: modelRevision } : {}),
      policy_ref: policyRef ?? `understudy://policy/${candidateId}@${policySha256(policy)}`,
      policy_sha256: policySha256(policy),
    },
    attempt,
    workload: {
      id: PARAMS.fixture,
      dataset_manifest_ref: datasetRef,
      dataset_manifest_sha256: fixtureSha,
      verifier_environment: VERIFIER_ENVIRONMENT,
      verifier_revision: verifierRevision,
    },
    // Train and dev only. The sealed holdout has no representation here.
    splits: {
      train_manifest_ref: `${datasetRef}#train`,
      train_manifest_sha256: v2SplitSha256("train"),
      dev_manifest_ref: `${datasetRef}#dev`,
      dev_manifest_sha256: v2SplitSha256("dev"),
    },
    limits,
  };
}

/**
 * Retrying an attempt must reach the same provider job rather than buy a second
 * one, so the key is derived from (experiment, candidate, attempt) alone.
 */
export function idempotencyKey(request) {
  return createHash("sha256")
    .update(`${request.experiment_id}\u0000${request.candidate.candidate_id}\u0000${request.attempt}`)
    .digest("hex");
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  const request = buildSubmitRequest({
    experimentId: argValue("--experiment-id", "bakeoff.multi-base.v1"),
    candidateId: argValue("--candidate-id"),
    executor: argValue("--executor", "fixture"),
    model: argValue("--model"),
    modelRevision: argValue("--model-revision"),
    renderer: argValue("--renderer"),
    rung: argValue("--rung", "base"),
    checkpoint: argValue("--checkpoint"),
    verifierRevision: argValue("--verifier-revision", contractSha256()),
    attempt: Number(argValue("--attempt", "0")),
    limits: {
      budget_usd: Number(argValue("--budget-usd", "25")),
      max_concurrent_candidates: Number(argValue("--max-concurrent-candidates", "3")),
      max_concurrent_requests_per_candidate: Number(argValue("--max-concurrent-requests", "8")),
      max_rollouts: Number(argValue("--max-rollouts", "2000")),
      max_runtime_seconds: Number(argValue("--max-runtime-seconds", "7200")),
    },
  });
  const outPath = argValue("--out");
  const document = { request, idempotency_key: idempotencyKey(request) };
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  }
  console.log(JSON.stringify(document, null, 2));
}
