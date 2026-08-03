import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutorCancellationReceiptSchema,
  ExecutorJobRefSchema,
  ExecutorJobStatusSchema,
  ExecutorUsageReceiptSchema,
  ExperimentSubmitRequestSchema,
  ModalExperimentExecutor,
} from "../dist/experiment-executor.js";

const request = {
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

function withFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = previous;
  };
}

test("canonical schemas accept representative executor receipts", () => {
  assert.doesNotThrow(() => ExperimentSubmitRequestSchema.parse({
    ...request,
    schema_version: "understudy.executor-submit.v1",
  }));
  assert.doesNotThrow(() => ExecutorJobRefSchema.parse(job));
  assert.doesNotThrow(() => ExecutorJobStatusSchema.parse({
    state: "running",
    observed_at: "2026-08-02T00:00:01Z",
    artifact_refs: [],
  }));
  assert.doesNotThrow(() => ExecutorCancellationReceiptSchema.parse({
    job,
    disposition: "cancelled",
    observed_at: "2026-08-02T00:00:02Z",
  }));
  assert.doesNotThrow(() => ExecutorUsageReceiptSchema.parse({
    evidence_scope: "unknown",
    requests: null,
    input_tokens: null,
    output_tokens: null,
    actual_usd: null,
    estimated_usd: 1.23,
    upper_bound_usd: 1.23,
    observed_at: "2026-08-02T00:00:03Z",
  }));
});

test("submit sends deterministic idempotency and bearer headers", async () => {
  let captured;
  const restore = withFetch(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(job), { status: 200 });
  });
  try {
    const result = await new ModalExperimentExecutor("https://executor.example/", "secret").submit(request);
    assert.deepEqual(result, job);
    assert.equal(captured.url, "https://executor.example/experiments");
    assert.equal(captured.init.headers.get("authorization"), "Bearer secret");
    assert.equal(captured.init.headers.get("idempotency-key"), "exp-1:candidate-a:2");
    assert.equal(captured.body.schema_version, "understudy.executor-submit.v1");
    assert.equal(captured.body.holdout, undefined);
  } finally {
    restore();
  }
});

test("inspect, cancel, and usage parse canonical responses", async () => {
  const responses = [
    { state: "running", observed_at: "2026-08-02T00:00:01Z", artifact_refs: [] },
    { job, disposition: "cancelled", observed_at: "2026-08-02T00:00:02Z" },
    {
      evidence_scope: "unknown",
      requests: null,
      input_tokens: null,
      output_tokens: null,
      actual_usd: null,
      estimated_usd: 1.23,
      upper_bound_usd: 1.23,
      observed_at: "2026-08-02T00:00:03Z",
    },
  ];
  const restore = withFetch(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  try {
    const client = new ModalExperimentExecutor("https://executor.example", "secret");
    assert.equal((await client.inspect(job)).state, "running");
    assert.equal((await client.cancel(job)).disposition, "cancelled");
    assert.equal((await client.reconcileUsage(job)).estimated_usd, 1.23);
  } finally {
    restore();
  }
});

test("client rejects missing credentials and non-canonical responses", async () => {
  assert.throws(() => new ModalExperimentExecutor("https://executor.example", ""), /API key/);
  const restore = withFetch(async () => new Response(JSON.stringify({ job: "job-1", status: "queued" }), { status: 200 }));
  try {
    await assert.rejects(
      new ModalExperimentExecutor("https://executor.example", "secret").inspect(job),
      /non-canonical/,
    );
  } finally {
    restore();
  }
});
