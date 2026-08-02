import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  EXECUTOR_SUBMIT_SCHEMA,
  SparkExperimentExecutor,
  idempotencyKeyFor,
} from "../dist/spark-experiment-executor.js";
import { ExperimentSubmitRequestSchema } from "../dist/experiment-executor.js";

/**
 * Contract fidelity is checked against the vendored canonical JSON Schemas, so
 * a divergence between this executor and the unified Workflow contract fails
 * here instead of at submit time against a real GPU job.
 */
function schema(name) {
  return JSON.parse(readFileSync(`schemas/understudy.executor-${name}.v1.schema.json`, "utf8"));
}

/** Minimal JSON-Schema-subset validator: type/required/enum/const/pattern/bounds. */
function schemaErrors(node, value, at = "$") {
  const errors = [];
  if ("const" in node && value !== node.const) errors.push(`${at}: expected ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (node.anyOf) {
    if (node.anyOf.every((branch) => schemaErrors(branch, value, at).length > 0)) errors.push(`${at}: no anyOf branch matched`);
    return errors;
  }
  const type = node.type;
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${at}: expected object`];
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = node.properties?.[key];
      if (!childSchema) {
        if (node.additionalProperties === false) errors.push(`${at}.${key}: additional property`);
        continue;
      }
      errors.push(...schemaErrors(childSchema, child, `${at}.${key}`));
    }
    return errors;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: expected array`];
    if (node.maxItems != null && value.length > node.maxItems) errors.push(`${at}: too many items`);
    value.forEach((item, index) => errors.push(...schemaErrors(node.items ?? {}, item, `${at}[${index}]`)));
    return errors;
  }
  if (type === "string") {
    if (typeof value !== "string") return [`${at}: expected string`];
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
    if (node.minLength != null && value.length < node.minLength) errors.push(`${at}: too short`);
    if (node.maxLength != null && value.length > node.maxLength) errors.push(`${at}: too long`);
    return errors;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number") return [`${at}: expected number`];
    if (type === "integer" && !Number.isInteger(value)) errors.push(`${at}: expected integer`);
    if (node.minimum != null && value < node.minimum) errors.push(`${at}: below minimum`);
    if (node.maximum != null && value > node.maximum) errors.push(`${at}: above maximum`);
    return errors;
  }
  if (type === "null" && value !== null) errors.push(`${at}: expected null`);
  return errors;
}

function assertValid(name, value) {
  assert.deepEqual(schemaErrors(schema(name), value), []);
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function submitRequest(overrides = {}) {
  return {
    schema_version: EXECUTOR_SUBMIT_SCHEMA,
    experiment_id: "exp-spark-nemotron-multilora",
    candidate: {
      candidate_id: "adapter-a",
      executor: "spark",
      model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16",
      model_revision: "2d59de1cbd51c0adf384eb906b766d1aee0e0517",
      policy_ref: "artifact://adapters/adapter-a/adapter_model.safetensors",
      policy_sha256: HASH_A,
    },
    attempt: 0,
    workload: {
      id: "automationbench-offline",
      dataset_manifest_ref: "artifact://fixtures/automationbench-offline/manifest.json",
      dataset_manifest_sha256: HASH_B,
      verifier_environment: "automationbench-offline",
      verifier_revision: "0341d79c",
    },
    splits: {
      train_manifest_ref: "artifact://fixtures/automationbench-offline/train.json",
      train_manifest_sha256: HASH_A,
      dev_manifest_ref: "artifact://fixtures/automationbench-offline/dev.json",
      dev_manifest_sha256: HASH_B,
    },
    limits: {
      budget_usd: 0,
      max_concurrent_candidates: 2,
      max_concurrent_requests_per_candidate: 4,
      max_rollouts: 48,
      max_runtime_seconds: 3600,
    },
    ...overrides,
  };
}

/** Records every call so "never a second paid job" is checked, not assumed. */
function recordingBackend(overrides = {}) {
  const starts = [];
  const backend = {
    starts,
    async start(input) {
      starts.push(input);
      return { job_id: `job-${starts.length}` };
    },
    async probe() {
      return { state: "running", artifact_refs: [] };
    },
    async cancel() {
      return "cancelled";
    },
    async usage() {
      return {
        evidence_scope: "account_window",
        requests: 12,
        input_tokens: 3400,
        output_tokens: 512,
        actual_usd: null,
        estimated_usd: null,
        upper_bound_usd: null,
      };
    },
    ...overrides,
  };
  return backend;
}

function executorAt(backend, iso = "2026-08-02T01:00:00Z") {
  return new SparkExperimentExecutor(backend, { now: () => new Date(iso) });
}

describe("spark experiment executor", () => {
  it("accepts a canonical submit request and rejects divergent payloads", () => {
    const request = submitRequest();
    assertValid("submit", request);
    assert.deepEqual(ExperimentSubmitRequestSchema.parse(request), request);

    // Holdout is structurally absent from the contract, not merely discouraged.
    assert.throws(() =>
      ExperimentSubmitRequestSchema.parse(
        submitRequest({
          splits: {
            train_manifest_ref: "artifact://train.json",
            train_manifest_sha256: HASH_A,
            dev_manifest_ref: "artifact://dev.json",
            dev_manifest_sha256: HASH_B,
            holdout_manifest_ref: "artifact://holdout.json",
          },
        }),
      ),
    );
    assert.throws(() =>
      ExperimentSubmitRequestSchema.parse(
        submitRequest({
          splits: {
            train_manifest_ref: "artifact://train.json",
            train_manifest_sha256: HASH_A,
            dev_manifest_ref: "artifact://dev.json",
          },
        }),
      ),
    );
    // Raw prompts/traces cannot ride along either.
    assert.throws(() => ExperimentSubmitRequestSchema.parse(submitRequest({ prompts: ["hello"] })));
    assert.throws(() => ExperimentSubmitRequestSchema.parse(submitRequest({ schema_version: "understudy.executor-submit.v2" })));
    assert.throws(() =>
      ExperimentSubmitRequestSchema.parse(
        submitRequest({ candidate: { ...submitRequest().candidate, policy_sha256: "not-a-hash" } }),
      ),
    );
  });

  it("derives the idempotency key from experiment, candidate and attempt only", () => {
    const base = submitRequest();
    const key = idempotencyKeyFor(base);
    assert.equal(key, idempotencyKeyFor(submitRequest({ limits: { ...base.limits, max_rollouts: 12 } })));
    assert.notEqual(key, idempotencyKeyFor(submitRequest({ attempt: 1 })));
    assert.notEqual(
      key,
      idempotencyKeyFor(submitRequest({ candidate: { ...base.candidate, candidate_id: "adapter-b" } })),
    );
    assert.notEqual(key, idempotencyKeyFor(submitRequest({ experiment_id: "exp-other" })));
  });

  it("returns a job ref immediately and never starts a second job for a retry", async () => {
    const backend = recordingBackend();
    const executor = executorAt(backend);
    const first = await executor.submit(submitRequest());
    const second = await executor.submit(submitRequest());

    assertValid("job-ref", first);
    assert.deepEqual(first, second);
    assert.equal(backend.starts.length, 1);
    assert.equal(backend.starts[0].idempotency_key, idempotencyKeyFor(submitRequest()));
    assert.equal(first.executor, "spark");

    // A new attempt is a new job.
    await executor.submit(submitRequest({ attempt: 1 }));
    assert.equal(backend.starts.length, 2);
  });

  it("refuses candidates addressed to another executor", async () => {
    const backend = recordingBackend();
    await assert.rejects(
      executorAt(backend).submit(submitRequest({ candidate: { ...submitRequest().candidate, executor: "modal" } })),
      /executor "modal"/,
    );
    assert.equal(backend.starts.length, 0);
  });

  it("reports status without inferring it from liveness", async () => {
    const executor = executorAt(
      recordingBackend({
        async probe() {
          return { state: "failed", artifact_refs: ["artifact://runs/job-1/events.jsonl"], failure_code: "adapter_load_failed" };
        },
      }),
    );
    const ref = await executor.submit(submitRequest());
    const status = await executor.inspect(ref);
    assertValid("job-status", status);
    assert.equal(status.state, "failed");
    assert.equal(status.failure_code, "adapter_load_failed");
    assert.deepEqual(status.artifact_refs, ["artifact://runs/job-1/events.jsonl"]);
  });

  it("records a cancellation receipt including the already-terminal case", async () => {
    let disposition = "cancelled";
    const executor = executorAt(
      recordingBackend({
        async cancel() {
          return disposition;
        },
      }),
    );
    const ref = await executor.submit(submitRequest());
    const cancelled = await executor.cancel(ref);
    assertValid("cancellation-receipt", cancelled);
    assert.equal(cancelled.disposition, "cancelled");
    assert.deepEqual(cancelled.job, ref);

    disposition = "already_terminal";
    assert.equal((await executor.cancel(ref)).disposition, "already_terminal");
  });

  it("reconciles usage with the scope the adapter can actually evidence", async () => {
    const executor = executorAt(recordingBackend());
    const ref = await executor.submit(submitRequest());
    const usage = await executor.reconcileUsage(ref);
    assertValid("usage-receipt", usage);
    // A shared self-hosted node cannot claim run-exclusive evidence.
    assert.equal(usage.evidence_scope, "account_window");
    assert.equal(usage.actual_usd, null);

    const unknown = await executorAt(
      recordingBackend({
        async usage() {
          return {
            evidence_scope: "unknown",
            requests: null,
            input_tokens: null,
            output_tokens: null,
            actual_usd: null,
            estimated_usd: null,
            upper_bound_usd: null,
          };
        },
      }),
    );
    const unknownRef = await unknown.submit(submitRequest());
    assertValid("usage-receipt", await unknown.reconcileUsage(unknownRef));
  });
});
