import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANCELLATION_DISPOSITIONS,
  EXECUTOR_SUBMIT_SCHEMA,
  ExecutorCancellationReceiptSchema,
  ExecutorJobRefSchema,
  ExecutorJobStatusSchema,
  ExecutorSubmitRequestSchema,
  ExecutorUsageReceiptSchema,
  USAGE_EVIDENCE_SCOPES,
  createFixtureExecutor,
  deterministicExecutorIdempotencyKey,
} from "../dist/executor-contract.js";

const HASH = "a".repeat(64);

function request(overrides = {}) {
  return {
    schema_version: EXECUTOR_SUBMIT_SCHEMA,
    experiment_id: "experiment.synthetic",
    candidate: {
      candidate_id: "candidate.fixture",
      executor: "fixture",
      model: "fixture-model",
      policy_ref: "refs/policy.json",
      policy_sha256: HASH,
    },
    attempt: 0,
    workload: {
      id: "workload.synthetic",
      dataset_manifest_ref: "refs/dataset.json",
      dataset_manifest_sha256: HASH,
      verifier_environment: "automationbench-v2",
      verifier_revision: "verifier-1",
    },
    splits: {
      train_manifest_ref: "refs/train.json",
      train_manifest_sha256: HASH,
      dev_manifest_ref: "refs/dev.json",
      dev_manifest_sha256: HASH,
    },
    limits: {
      budget_usd: 1,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 1,
      max_rollouts: 10,
      max_runtime_seconds: 60,
    },
    ...overrides,
  };
}

describe("executor contract surface", () => {
  it("uses a deterministic idempotency key and returns one job on retry", async () => {
    const adapter = createFixtureExecutor({ now: () => "2026-08-02T00:00:00.000Z" });
    const input = request();
    const first = await adapter.submit(input);
    const retry = await adapter.submit(structuredClone(input));
    assert.equal(retry.job_id, first.job_id);
    assert.equal(retry.idempotency_key, first.idempotency_key);
    assert.equal(
      first.idempotency_key,
      deterministicExecutorIdempotencyKey(input),
    );
    assert.deepEqual(ExecutorJobRefSchema.parse(first), first);
  });

  it("keeps holdout structurally absent from submit payloads", () => {
    const invalid = request({ splits: { ...request().splits, holdout_manifest_ref: "refs/holdout.json" } });
    assert.throws(() => ExecutorSubmitRequestSchema.parse(invalid), /Unrecognized key/);
  });

  it("rejects raw traces, prompts, labels, weights, and secrets", () => {
    for (const key of ["raw_trace", "prompt", "labels", "weights", "secret"]) {
      const invalid = request({ [key]: "must-not-cross-the-boundary" });
      assert.throws(() => ExecutorSubmitRequestSchema.parse(invalid), /Unrecognized key/);
    }
    const invalidNested = request({ candidate: { ...request().candidate, prompt: "raw" } });
    assert.throws(() => ExecutorSubmitRequestSchema.parse(invalidNested), /Unrecognized key/);
  });

  it("records cancellation through the adapter and returns a conformant receipt", async () => {
    const adapter = createFixtureExecutor({ now: () => "2026-08-02T00:00:00.000Z" });
    const job = await adapter.submit(request());
    const receipt = await adapter.cancel(job);
    assert.equal(receipt.disposition, "cancelled");
    assert.ok(CANCELLATION_DISPOSITIONS.includes(receipt.disposition));
    assert.deepEqual(ExecutorCancellationReceiptSchema.parse(receipt), receipt);
    assert.equal((await adapter.inspect(job)).state, "cancelled");
    assert.equal((await adapter.cancel(job)).disposition, "already_terminal");
  });

  it("records not_found cancellation receipts for unknown jobs", async () => {
    const adapter = createFixtureExecutor({ now: () => "2026-08-02T00:00:00.000Z" });
    const unknown = {
      executor: "fixture",
      job_id: "fixture-missing",
      idempotency_key: "missing-key",
      submitted_at: "2026-08-02T00:00:00.000Z",
    };
    const receipt = await adapter.cancel(unknown);
    assert.equal(receipt.disposition, "not_found");
    assert.deepEqual(receipt.job, unknown);
    assert.deepEqual(ExecutorCancellationReceiptSchema.parse(receipt), receipt);
  });

  it("takes usage evidence scope from the adapter and round-trips null evidence", async () => {
    for (const evidence_scope of USAGE_EVIDENCE_SCOPES) {
      const adapter = createFixtureExecutor({
        evidence_scope,
        now: () => "2026-08-02T00:00:00.000Z",
        usage: {
          requests: null,
          input_tokens: null,
          output_tokens: null,
          actual_usd: null,
          estimated_usd: null,
          upper_bound_usd: null,
        },
      });
      const job = await adapter.submit(request());
      const usage = await adapter.reconcileUsage(job);
      assert.equal(usage.evidence_scope, evidence_scope);
      assert.equal(usage.actual_usd, null);
      assert.equal(usage.estimated_usd, null);
      assert.equal(usage.upper_bound_usd, null);
      assert.deepEqual(ExecutorUsageReceiptSchema.parse(usage), usage);
    }
  });

  it("preserves actual, estimated, and upper-bound usage semantics", async () => {
    const adapter = createFixtureExecutor({
      evidence_scope: "run_exclusive",
      usage: {
        requests: 3,
        input_tokens: 100,
        output_tokens: 40,
        actual_usd: 0.12,
        estimated_usd: 0.1,
        upper_bound_usd: 0.2,
      },
    });
    const usage = await adapter.reconcileUsage(await adapter.submit(request()));
    assert.equal(usage.actual_usd, 0.12);
    assert.equal(usage.estimated_usd, 0.1);
    assert.equal(usage.upper_bound_usd, 0.2);
    assert.deepEqual(ExecutorUsageReceiptSchema.parse(usage), usage);
  });

  it("does not pretend the local Tinker arm is a published executor", async () => {
    const adapter = createFixtureExecutor();
    await assert.rejects(
      adapter.submit(request({ candidate: { ...request().candidate, executor: "fireworks" } })),
      /candidate\.executor=fixture/,
    );
    assert.deepEqual(
      ExecutorJobStatusSchema.parse({ state: "queued", observed_at: "2026-08-02T00:00:00.000Z" }),
      { state: "queued", observed_at: "2026-08-02T00:00:00.000Z" },
    );
  });
});
