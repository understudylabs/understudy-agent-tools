import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createExperimentExecutor,
  experimentIdempotencyKey,
  submitCandidateJob,
} from "../dist/process-reward-grpo-workflow.js";

const schema = JSON.parse(
  await readFile(new URL("../schemas/understudy.executor-submit.v1.schema.json", import.meta.url)),
);

const request = {
  schema_version: "understudy.executor-submit.v1",
  experiment_id: "process-reward-grpo-v2",
  candidate: {
    candidate_id: "terminal",
    executor: "fixture",
    model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
    policy_ref: "artifact://process-reward-grpo/base-policy",
    policy_sha256: "a".repeat(64),
  },
  attempt: 0,
  workload: {
    id: "automationbench-v2",
    dataset_manifest_ref: "artifact://automationbench-v2/manifest",
    dataset_manifest_sha256: "b".repeat(64),
    verifier_environment: "automationbench-v2",
    verifier_revision: "local-public-fixture",
  },
  splits: {
    train_manifest_ref: "artifact://automationbench-v2/train",
    train_manifest_sha256: "c".repeat(64),
    dev_manifest_ref: "artifact://automationbench-v2/dev",
    dev_manifest_sha256: "d".repeat(64),
  },
  limits: {
    budget_usd: 100,
    max_concurrent_candidates: 2,
    max_concurrent_requests_per_candidate: 1,
    max_rollouts: 640,
    max_runtime_seconds: 7200,
  },
};

test("submit payload matches understudy.executor-submit.v1 exactly", () => {
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal("holdout" in request, false);
  assert.deepEqual(Object.keys(request).sort(), [
    "attempt",
    "candidate",
    "experiment_id",
    "limits",
    "schema_version",
    "splits",
    "workload",
  ]);
});

test("idempotency is the null-separated experiment tuple", () => {
  const expected = experimentIdempotencyKey({
    experimentId: request.experiment_id,
    candidateId: request.candidate.candidate_id,
    attempt: request.attempt,
  });
  const job = submitCandidateJob({
    request,
    experimentId: request.experiment_id,
    candidateId: request.candidate.candidate_id,
    attempt: request.attempt,
    jobId: "job-terminal",
    submittedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(job.idempotencyKey, expected);
});

test("executor boundary forwards cancellation receipt and evidence scope", async () => {
  const calls = [];
  const executor = createExperimentExecutor({
    async submit(payload, key) {
      calls.push(["submit", payload, key]);
      return submitCandidateJob({
        request: payload,
        experimentId: payload.experiment_id,
        candidateId: payload.candidate.candidate_id,
        attempt: payload.attempt,
        jobId: "job-terminal",
        submittedAt: "2026-01-01T00:00:00.000Z",
      });
    },
    async inspect(job) {
      calls.push(["inspect", job.jobId]);
      return job;
    },
    async cancel(job, evidenceScope) {
      calls.push(["cancel", evidenceScope]);
      return { job, cancelled: true, evidence_scope: evidenceScope, artifact: { uri: "artifact://cancel", sha256: "c".repeat(64) } };
    },
    async reconcileUsage(job, evidenceScope) {
      calls.push(["usage", evidenceScope]);
      return { job, status: "succeeded", promptTokens: 1, completionTokens: 2, artifact: { uri: "artifact://usage", sha256: "d".repeat(64) } };
    },
  });
  const job = await executor.submit({
    request,
    experimentId: request.experiment_id,
    candidateId: request.candidate.candidate_id,
    attempt: request.attempt,
    jobId: "job-terminal",
    submittedAt: "2026-01-01T00:00:00.000Z",
  });
  const cancellation = await executor.cancel(job, "training");
  const usage = await executor.reconcileUsage(job, "training");
  assert.equal(cancellation.cancelled, true);
  assert.equal(cancellation.evidence_scope, "training");
  assert.equal(usage.status, "succeeded");
  assert.deepEqual(calls.map(([kind, value]) => [kind, value]), [
    ["submit", request],
    ["cancel", "training"],
    ["usage", "training"],
  ]);
});
