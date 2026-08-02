import assert from "node:assert/strict";
import test from "node:test";
import {
  ExperimentSubmitRequestSchema,
  ModalExperimentExecutor,
} from "../dist/experiment-executor.js";

const request = {
  experimentId: "exp-1",
  candidate: {
    candidateId: "candidate-a",
    model: "nemotron",
    policyRef: "r2://policies/policy.json",
    policySha256: "b".repeat(64),
  },
  attempt: 2,
  workload: {
    id: "automationbench",
    datasetManifestRef: "r2://datasets/manifest.json",
    datasetManifestSha256: "a".repeat(64),
    verifierEnvironment: "offline-v1",
    verifierRevision: "rev-1",
  },
  splits: {
    trainManifestRef: "r2://datasets/train.json",
    devManifestRef: "r2://datasets/dev.json",
  },
  limits: {
    budgetUsd: 10,
    maxConcurrentCandidates: 1,
    maxConcurrentRequestsPerCandidate: 2,
    maxRollouts: 4,
    maxRuntimeSeconds: 120,
  },
};

function withFetch(handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = previous;
  };
}

test("submit sends matching idempotency header and body with bearer auth", async () => {
  assert.doesNotThrow(() => ExperimentSubmitRequestSchema.parse({
    ...request,
    idempotencyKey: "exp-1:candidate-a:2",
  }));
  let captured;
  const restore = withFetch(async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      jobId: "job-1",
      idempotencyKey: "exp-1:candidate-a:2",
      status: "queued",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const client = new ModalExperimentExecutor("https://executor.example/", "secret");
    const result = await client.submit(request);
    assert.equal(result.jobId, "job-1");
    assert.equal(captured.url, "https://executor.example/experiments");
    assert.equal(captured.init.headers.get("authorization"), "Bearer secret");
    assert.equal(captured.init.headers.get("idempotency-key"), "exp-1:candidate-a:2");
    assert.equal(captured.body.idempotencyKey, "exp-1:candidate-a:2");
  } finally {
    restore();
  }
});

test("cancel returns a receipt-shaped response", async () => {
  const restore = withFetch(async (url, init) => {
    assert.equal(init.method, "DELETE");
    assert.equal(url, "https://executor.example/experiments/job-1");
    return new Response(JSON.stringify({
      jobId: "job-1",
      status: "cancelled",
      cancelledAt: "2026-08-02T00:00:00Z",
    }), { status: 200 });
  });
  try {
    assert.deepEqual(
      await new ModalExperimentExecutor("https://executor.example").cancel("job-1"),
      {
        jobId: "job-1",
        status: "cancelled",
        cancelledAt: "2026-08-02T00:00:00Z",
      },
    );
  } finally {
    restore();
  }
});

test("reconcileUsage carries evidence", async () => {
  const restore = withFetch(async () => new Response(JSON.stringify({
    estimated_usd: 1.23,
    gpuSeconds: 975,
    evidence_scope: "estimated",
  }), { status: 200 }));
  try {
    const usage = await new ModalExperimentExecutor("https://executor.example").reconcileUsage("job-1");
    assert.deepEqual(usage, {
      estimated_usd: 1.23,
      gpuSeconds: 975,
      evidence_scope: "estimated",
    });
  } finally {
    restore();
  }
});
