import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ExperimentExecutor,
  buildCandidateSubmitRequest,
  emitCandidateSubmitRequest,
  validateExecutorSubmitRequest,
} from "../dist/experiment-executor.js";

const submitSchema = JSON.parse(
  readFileSync("schemas/understudy.executor-submit.v1.schema.json", "utf8"),
);

function validRequest() {
  return {
    schema_version: submitSchema.properties.schema_version.const,
    experiment_id: "experiment-1",
    candidate: {
      candidate_id: "c4",
      executor: "fixture",
      model: "model-a",
      policy_ref: "artifact://candidate/c4/policy.txt",
      policy_sha256: "a".repeat(64),
    },
    attempt: 0,
    workload: {
      id: "synthetic-fixture",
      dataset_manifest_ref: "fixture://synthetic-fixture/manifest.json",
      dataset_manifest_sha256: "b".repeat(64),
      verifier_environment: "synthetic-fixture",
      verifier_revision: "b".repeat(64),
    },
    splits: {
      train_manifest_ref: `fixture://synthetic-fixture/train/${"c".repeat(64)}`,
      train_manifest_sha256: "c".repeat(64),
      dev_manifest_ref: `fixture://synthetic-fixture/dev/${"d".repeat(64)}`,
      dev_manifest_sha256: "d".repeat(64),
    },
    limits: {
      budget_usd: 0,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 1,
      max_rollouts: 10,
      max_runtime_seconds: 60,
    },
  };
}

function assertSchemaShape(value) {
  for (const key of submitSchema.required) assert.notEqual(value[key], undefined, `missing ${key}`);
  assert.equal(value.schema_version, submitSchema.properties.schema_version.const);
  for (const key of Object.keys(value)) {
    assert.ok(Object.hasOwn(submitSchema.properties, key), `unknown top-level key ${key}`);
  }
}

describe("experiment executor contract", () => {
  it("returns the same job ref for an idempotent triple", () => {
    const executor = new ExperimentExecutor(() => ({
      evidence_scope: "run_exclusive",
      requests: 1,
      input_tokens: 2,
      output_tokens: 3,
      actual_usd: null,
      estimated_usd: null,
      upper_bound_usd: null,
      observed_at: "2026-08-02T00:00:00Z",
    }));
    const input = validRequest();
    const first = executor.submit(input);
    const second = executor.submit(structuredClone(input));
    assert.deepEqual(first, second);
    assert.equal(executor.inspect(first).state, "queued");
  });

  it("produces cancelled, already-terminal, and not-found receipts", () => {
    const executor = new ExperimentExecutor(() => ({
      evidence_scope: "unknown",
      requests: null,
      input_tokens: null,
      output_tokens: null,
      actual_usd: null,
      estimated_usd: null,
      upper_bound_usd: null,
      observed_at: "2026-08-02T00:00:00Z",
    }));
    const job = executor.submit(validRequest());
    assert.equal(executor.cancel(job).disposition, "cancelled");
    assert.equal(executor.cancel(job).disposition, "already_terminal");
    assert.equal(
      executor.cancel({ ...job, job_id: "missing", idempotency_key: "missing" }).disposition,
      "not_found",
    );
  });

  it("returns adapter-supplied evidence scope without hardcoding it", () => {
    let called = false;
    const executor = new ExperimentExecutor((job) => {
      called = job.job_id.length > 0;
      return {
        evidence_scope: "account_window",
        requests: 4,
        input_tokens: 5,
        output_tokens: 6,
        actual_usd: 0.1,
        estimated_usd: null,
        upper_bound_usd: null,
        observed_at: "2026-08-02T00:00:00Z",
      };
    });
    const receipt = executor.reconcileUsage(executor.submit(validRequest()));
    assert.equal(called, true);
    assert.equal(receipt.evidence_scope, "account_window");
  });

  it("emits a schema-shaped candidate request with refs and hashes only", () => {
    const candidate = {
      candidate_id: "c4",
      policy_sha256: "a".repeat(64),
      fixture: "synthetic-fixture",
      fixture_sha256: "b".repeat(64),
      train_split_sha256: "c".repeat(64),
      dev_split_sha256: "d".repeat(64),
      gepa_config: {
        model: "model-a",
        concurrency: 8,
        max_rollouts: 600,
      },
    };
    const payload = buildCandidateSubmitRequest(candidate);
    assertSchemaShape(payload);
    assert.deepEqual(validateExecutorSubmitRequest(payload), []);
    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes("raw prompt text"), false);
    assert.equal(encoded.includes("trace contents"), false);
    assert.equal(encoded.includes("secret"), false);
    const emitted = emitCandidateSubmitRequest(
      "outputs/gepa-run/candidate.json",
      "/tmp/understudy-candidate-submit.json",
      { model: "model-a" },
    );
    assert.match(emitted.splits.train_manifest_sha256, /^[a-f0-9]{64}$/);
  });

  it("rejects unknown fields, bad hashes, and holdout-bearing payloads", () => {
    const extra = validRequest();
    extra.extra = true;
    assert.ok(validateExecutorSubmitRequest(extra).some((error) => error.includes("extra")));

    const badHash = validRequest();
    badHash.candidate.policy_sha256 = "not-a-hash";
    assert.ok(validateExecutorSubmitRequest(badHash).some((error) => error.includes("policy_sha256")));

    const holdout = validRequest();
    holdout.splits.holdout_manifest_ref = "fixture://synthetic-fixture/holdout/hash";
    assert.ok(validateExecutorSubmitRequest(holdout).some((error) => error.includes("holdout")));
    assert.throws(() => new ExperimentExecutor(() => {
      throw new Error("unused");
    }).submit(holdout), /invalid executor submit request/);
  });
});
