#!/usr/bin/env node
/**
 * Emit this arm's candidate as an `understudy.executor-submit.v1` payload.
 *
 * WL-OR is a candidate-method arm, not an executor: it produces the payload a
 * durable run controller submits, and owns no controller, poller, or queue of
 * its own. The payload carries refs and hashes only — never weights, raw
 * traces, prompts, labels, or credentials — and the sealed holdout is
 * structurally absent, as the contract requires.
 *
 * The payload is a pure function of the pins below, so re-emitting it for the
 * same (experiment_id, candidate_id, attempt) is byte-identical: a retry
 * resolves to the same job rather than opening a second paid one.
 *
 * Usage:
 *   node experiments/workload-orchestrator/submit-payload.mjs \
 *     [--experiment <id>] [--attempt 0] [--out <path>]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SLICE, sliceSha256, sliceSplitSha256 } from "./slice.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARM = "experiments/workload-orchestrator";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/**
 * The candidate policy: what was trained, from which pairs, with which knobs.
 * Hashing the descriptor — not the weights — is what makes the candidate
 * identifiable without moving anything sensitive.
 */
export function policyDescriptor() {
  const receipt = JSON.parse(readFileSync(join(HERE, "artifacts/dpo-train-receipt.json"), "utf8"));
  return {
    method: "dpo",
    base_model: receipt.base_model,
    renderer: receipt.renderer,
    checkpoint_ref: receipt.checkpoint,
    hyperparameters: receipt.hyperparameters,
    pairs_sha256: receipt.source_pairs_sha256,
    pairs: receipt.pairs,
  };
}

export function submitPayload({ experimentId, attempt }) {
  const policy = policyDescriptor();
  const policySha256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: experimentId,
    candidate: {
      candidate_id: "wl-or-dpo-b0.1-e3-r32",
      // Tinker is not in the executor enum; the scored lane here is the offline
      // verifier fixture, and the policy itself is carried by reference.
      executor: "fixture",
      model: policy.base_model,
      model_revision: "BF16",
      policy_ref: `${ARM}/artifacts/dpo-train-receipt.json`,
      policy_sha256: policySha256,
    },
    attempt,
    workload: {
      id: SLICE.slice_id,
      dataset_manifest_ref: `${ARM}/artifacts/slice-gates.json`,
      dataset_manifest_sha256: sliceSha256(),
      verifier_environment: `${SLICE.benchmark_id} (offline, outcome-first)`,
      verifier_revision: sliceSplitSha256("train"),
    },
    splits: {
      train_manifest_ref: `${ARM}/slice.mjs#train@${sliceSplitSha256("train")}`,
      dev_manifest_ref: `${ARM}/slice.mjs#dev@${sliceSplitSha256("dev")}`,
    },
    limits: {
      budget_usd: 25,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 10,
      max_rollouts: 200,
      max_runtime_seconds: 7200,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const payload = submitPayload({
    experimentId: argValue("--experiment", "wl-or-orchestrator-repair"),
    attempt: Number(argValue("--attempt", "0")),
  });
  const outPath = argValue("--out", join(HERE, "artifacts/executor-submit.json"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload, null, 2));
}
