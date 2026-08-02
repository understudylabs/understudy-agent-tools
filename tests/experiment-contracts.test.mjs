import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ExperimentSubmitRequestSchema,
  ExecutorCancellationReceiptSchema,
  ExecutorJobRefSchema,
  ExecutorJobStatusSchema,
  ExecutorUsageReceiptSchema,
} from "../dist/experiment-executor.js";

const schemaDir = path.resolve("schemas");
const manifest = JSON.parse(
  fs.readFileSync(path.join(schemaDir, "experiment-executor-contract-manifest.json"), "utf8"),
);

test("vendored executor schema digests match the canonical manifest", () => {
  for (const [file, expected] of Object.entries(manifest.schemas)) {
    if (!file.startsWith("experiment-executor-")) continue;
    const actual = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(schemaDir, file)))
      .digest("hex");
    assert.equal(actual, expected, `${file} digest drifted`);
  }
  const bundle = Object.entries(manifest.schemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, digest]) => `${file}:${digest}\n`)
    .join("");
  assert.equal(
    crypto.createHash("sha256").update(bundle).digest("hex"),
    manifest.bundle_sha256,
  );
});

test("canonical executor fixtures validate through the Zod mirrors", () => {
  const request = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: "exp-1",
    candidate: {
      candidate_id: "candidate-a",
      executor: "modal",
      model: "nemotron",
      policy_ref: "r2://policies/policy.json",
      policy_sha256: "b".repeat(64),
    },
    attempt: 2,
    workload: {
      id: "automationbench",
      dataset_manifest_ref: "r2://datasets/manifest.json",
      dataset_manifest_sha256: "a".repeat(64),
      verifier_environment: "offline-v1",
      verifier_revision: "rev-1",
    },
    splits: {
      train_manifest_ref: "r2://datasets/train.json",
      train_manifest_sha256: "c".repeat(64),
      dev_manifest_ref: "r2://datasets/dev.json",
      dev_manifest_sha256: "d".repeat(64),
    },
    limits: {
      budget_usd: 10,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 2,
      max_rollouts: 4,
      max_runtime_seconds: 120,
    },
  };
  const job = {
    executor: "modal",
    job_id: "job-1",
    idempotency_key: "exp-1:candidate-a:2",
    submitted_at: "2026-08-02T00:00:00Z",
  };
  ExperimentSubmitRequestSchema.parse(request);
  ExecutorJobRefSchema.parse(job);
  ExecutorJobStatusSchema.parse({
    state: "queued",
    observed_at: "2026-08-02T00:00:00Z",
    artifact_refs: [],
  });
  ExecutorCancellationReceiptSchema.parse({
    job,
    disposition: "cancelled",
    observed_at: "2026-08-02T00:00:00Z",
  });
  ExecutorUsageReceiptSchema.parse({
    evidence_scope: "unknown",
    requests: null,
    input_tokens: null,
    output_tokens: null,
    actual_usd: null,
    estimated_usd: 1.23,
    upper_bound_usd: null,
    observed_at: "2026-08-02T00:00:00Z",
  });
});
