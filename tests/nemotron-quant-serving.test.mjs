import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ExecutorContractError,
  PRECISION_LANES,
  canonicalJson,
  createModalQuantExecutor,
  idempotencyKey,
  laneForModel,
  policySha256,
  validateSubmitRequest,
} from "../experiments/nemotron-quant-serving/modal-quant-executor.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const experimentDir = join(root, "experiments", "nemotron-quant-serving");
const contractDir = join(experimentDir, "contracts");

const readContract = (name) => JSON.parse(readFileSync(join(contractDir, name), "utf8"));

function submitRequest(overrides = {}) {
  return {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: "quant-for-serving-2026-08",
    candidate: {
      candidate_id: "nemotron-3-nano-fp8",
      executor: "modal",
      model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8",
      model_revision: "f8dc1c0afee92f44417695b4f5ddca9afc95ea58",
      policy_ref: "artifact://policies/nemotron-3-nano-fp8.json",
      policy_sha256: "a".repeat(64),
    },
    attempt: 0,
    workload: {
      id: "automationbench-simple-api-offline-v2",
      dataset_manifest_ref: "artifact://manifests/automationbench-v2.json",
      dataset_manifest_sha256: "b".repeat(64),
      verifier_environment: "src/automationbench-offline.ts",
      verifier_revision: "918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22",
    },
    splits: {
      train_manifest_ref: "artifact://splits/automationbench-v2-train.json",
      train_manifest_sha256: "71a58657efad873bc21ec13a2b8fdaf2fde483cbcfeb8f6dbc4824207d51758b",
      dev_manifest_ref: "artifact://splits/automationbench-v2-dev.json",
      dev_manifest_sha256: "f125ee0096802c57894644c5af0d8b3531cb9d7f8210a1cfd8a700afcbb52135",
    },
    limits: {
      budget_usd: 25,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 16,
      max_rollouts: 96,
      max_runtime_seconds: 3600,
    },
    ...overrides,
  };
}

/** Minimal in-memory stand-in for Modal. No provider calls anywhere in this file. */
function fakeDriver() {
  const jobs = new Map();
  let counter = 0;
  return {
    jobs,
    starts: 0,
    stops: 0,
    async findJob(key) {
      return jobs.get(key) ?? null;
    },
    async startJob(spec) {
      this.starts += 1;
      counter += 1;
      const job = {
        job_id: `modal-job-${counter}`,
        submitted_at: "2026-08-02T03:00:00Z",
        state: "running",
        spec,
      };
      jobs.set(spec.idempotency_key, job);
      return job;
    },
    async describeJob(jobId) {
      for (const job of jobs.values()) if (job.job_id === jobId) return job;
      return null;
    },
    async stopJob(jobId) {
      this.stops += 1;
      for (const job of jobs.values()) {
        if (job.job_id === jobId) {
          job.state = "cancelled";
          return { stopped: true };
        }
      }
      return { stopped: false };
    },
    async usage() {
      return null;
    },
  };
}

test("the vendored contract is the canonical executor-submit schema", () => {
  const schema = readContract("experiment-executor-submit-request.json");
  assert.equal(schema.properties.schema_version.const, "understudy.executor-submit.v1");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schema_version",
    "experiment_id",
    "candidate",
    "attempt",
    "workload",
    "splits",
    "limits",
  ]);
});

test("holdout is structurally absent from every submit-side contract", () => {
  const schema = JSON.stringify(readContract("experiment-executor-submit-request.json"));
  assert.equal(/holdout/i.test(schema), false);
  assert.deepEqual(Object.keys(readContract("experiment-executor-submit-request.json").properties.splits.properties), [
    "train_manifest_ref",
    "train_manifest_sha256",
    "dev_manifest_ref",
    "dev_manifest_sha256",
  ]);
});

test("the validator accepts exactly the canonical property set", () => {
  const schema = readContract("experiment-executor-submit-request.json");
  const request = submitRequest();
  assert.deepEqual(Object.keys(request).sort(), Object.keys(schema.properties).sort());
  assert.doesNotThrow(() => validateSubmitRequest(request));

  for (const [path, mutate] of [
    ["candidate", (r) => delete r.candidate.policy_sha256],
    ["workload", (r) => delete r.workload.verifier_revision],
    ["splits", (r) => delete r.splits.dev_manifest_ref],
    ["limits", (r) => delete r.limits.budget_usd],
  ]) {
    const broken = submitRequest();
    mutate(broken);
    assert.throws(() => validateSubmitRequest(broken), ExecutorContractError, `${path} must be required`);
  }
});

test("a submit request carrying holdout or raw data is rejected", () => {
  for (const smuggled of [
    { holdout_manifest_ref: "artifact://splits/holdout.json" },
    { traces: [{ prompt: "raw prompt text" }] },
  ]) {
    assert.throws(() => validateSubmitRequest(submitRequest(smuggled)), ExecutorContractError);
  }

  const withHoldoutSplit = submitRequest();
  withHoldoutSplit.splits.holdout_manifest_ref = "artifact://splits/holdout.json";
  assert.throws(() => validateSubmitRequest(withHoldoutSplit), ExecutorContractError);
});

test("a non-Modal candidate is not this adapter's to run", () => {
  const request = submitRequest();
  request.candidate.executor = "fireworks";
  assert.throws(() => validateSubmitRequest(request), ExecutorContractError);
});

test("the idempotency key is a pure function of experiment, candidate and attempt", () => {
  const base = { experiment_id: "e1", candidate_id: "c1", attempt: 0 };
  assert.equal(idempotencyKey(base), idempotencyKey({ ...base }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, attempt: 1 }));
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, candidate_id: "c2" }));
  assert.match(idempotencyKey(base), /^[a-f0-9]{64}$/);
});

test("a retried submit re-attaches instead of starting a second paid lane", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  const first = await executor.submit(submitRequest());
  const retry = await executor.submit(submitRequest());

  assert.equal(driver.starts, 1);
  assert.equal(first.job_id, retry.job_id);
  assert.equal(first.idempotency_key, retry.idempotency_key);

  // A new attempt is a different key, and is allowed to start a new lane.
  await executor.submit(submitRequest({ attempt: 1 }));
  assert.equal(driver.starts, 2);
});

test("submit routes each precision to its own serving lane", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  for (const [lane, expected] of Object.entries(PRECISION_LANES)) {
    const request = submitRequest();
    request.candidate.candidate_id = `nemotron-3-nano-${lane}`;
    request.candidate.model = `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-${lane.toUpperCase()}`;
    const ref = await executor.submit(request);
    const job = await driver.describeJob(ref.job_id);
    assert.equal(job.spec.web_function, expected.web_function);
  }
  assert.throws(() => laneForModel("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-INT2"), ExecutorContractError);
});

test("submitted specs carry refs and hashes only, never raw data or secrets", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  const ref = await executor.submit(submitRequest());
  const job = await driver.describeJob(ref.job_id);
  const serialized = JSON.stringify(job.spec);

  assert.equal(/holdout/i.test(serialized), false);
  for (const key of ["prompt", "trace", "label", "api_key", "token", "weights"]) {
    assert.equal(serialized.toLowerCase().includes(key), false, `spec must not carry ${key}`);
  }
  assert.match(job.spec.policy_sha256, /^[a-f0-9]{64}$/);
});

test("cancellation always records a receipt, including when there is nothing to cancel", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  const ref = await executor.submit(submitRequest());

  const cancelled = await executor.cancel(ref);
  assert.equal(cancelled.disposition, "cancelled");
  assert.equal(cancelled.job.job_id, ref.job_id);
  assert.match(cancelled.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  assert.equal((await executor.cancel(ref)).disposition, "already_terminal");
  assert.equal((await executor.cancel({ ...ref, job_id: "missing" })).disposition, "not_found");
});

test("usage reconciliation reports its evidence scope instead of assuming one", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  const ref = await executor.submit(submitRequest());

  const unknown = await executor.reconcileUsage(ref);
  assert.equal(unknown.evidence_scope, "unknown");
  assert.equal(unknown.actual_usd, null);

  driver.usage = async () => ({ evidence_scope: "account_window", requests: 96, estimated_usd: 4.2 });
  const scoped = await executor.reconcileUsage(ref);
  assert.equal(scoped.evidence_scope, "account_window");
  assert.equal(scoped.estimated_usd, 4.2);
  assert.equal(scoped.actual_usd, null, "an unmeasured cost stays null rather than being invented");

  const schema = readContract("experiment-executor-usage-receipt.json");
  assert.deepEqual(Object.keys(scoped).sort(), [...schema.required].sort());
});

test("inspect maps driver state onto the canonical job-status shape", async () => {
  const driver = fakeDriver();
  const executor = createModalQuantExecutor(driver);
  const ref = await executor.submit(submitRequest());

  const running = await executor.inspect(ref);
  assert.equal(running.state, "running");

  const missing = await executor.inspect({ ...ref, job_id: "gone" });
  assert.equal(missing.state, "failed");
  assert.equal(missing.failure_code, "job_not_found");

  const states = readContract("experiment-executor-job-status.json").properties.state.enum;
  assert.ok(states.includes(running.state) && states.includes(missing.state));
});

test("policy hashes separate precision lanes and survive key reordering", () => {
  const bf16 = { precision: "bf16", max_model_len: 32768, temperature: 0 };
  const fp8 = { precision: "fp8", max_model_len: 32768, temperature: 0 };
  assert.notEqual(policySha256(bf16), policySha256(fp8));
  assert.equal(policySha256(bf16), policySha256({ temperature: 0, max_model_len: 32768, precision: "bf16" }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// --- report contract -------------------------------------------------------

function runSummary({ split, mean, band = "core", forbidden = 0, sha = "c".repeat(64) }) {
  return {
    model: `nemotron-3-nano-${split}`,
    split,
    split_sha256: sha,
    rows: Array.from({ length: 4 }, (_, index) => ({
      task_id: `t${index}`,
      band,
      score: mean,
      forbidden_effects: index === 0 ? forbidden : 0,
      malformed: 0,
      prompt_tokens: 100,
      completion_tokens: 50,
    })),
  };
}

function writeLane(dir, name, { dev, holdout, throughput }) {
  const paths = {};
  for (const [kind, value] of Object.entries({ dev, holdout, throughput })) {
    const path = join(dir, `${name}-${kind}.json`);
    writeFileSync(path, JSON.stringify(value));
    paths[kind] = path;
  }
  return `${name}:${paths.dev}:${paths.holdout}:${paths.throughput}`;
}

const throughput = (gpuUsdPerHour, tokensPerSecond) => ({
  gpu: "B200",
  gpu_usd_per_hour: gpuUsdPerHour,
  peak_output_tokens_per_s: tokensPerSecond,
  usd_per_million_output_tokens: Number(((gpuUsdPerHour / (tokensPerSecond * 3600)) * 1e6).toFixed(2)),
});

function report(lanes) {
  const dir = mkdtempSync(join(tmpdir(), "quant-report-"));
  const args = [join(experimentDir, "quant-cost-report.mjs"), "--reference", "bf16"];
  for (const [name, lane] of Object.entries(lanes)) args.push("--lane", writeLane(dir, name, lane));
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
}

test("the report recommends the cheapest lane inside the predeclared tolerance", () => {
  const result = report({
    bf16: {
      dev: runSummary({ split: "dev", mean: 0.84 }),
      holdout: runSummary({ split: "holdout", mean: 0.8 }),
      throughput: throughput(6.25, 900),
    },
    fp8: {
      dev: runSummary({ split: "dev", mean: 0.83 }),
      holdout: runSummary({ split: "holdout", mean: 0.79 }),
      throughput: throughput(6.25, 1400),
    },
    nvfp4: {
      // Inside the mean tolerance on dev, but the holdout collapses.
      dev: runSummary({ split: "dev", mean: 0.825 }),
      holdout: runSummary({ split: "holdout", mean: 0.7 }),
      throughput: throughput(6.25, 2100),
    },
  });

  assert.equal(result.recommended_precision, "fp8");
  const nvfp4 = result.lanes.find((lane) => lane.precision === "nvfp4");
  assert.equal(nvfp4.within_tolerance, false, "the cheapest lane must not win by being cheap alone");
  assert.ok(nvfp4.breaches.some((breach) => breach.startsWith("holdout mean")));
});

test("extra forbidden writes disqualify a lane however fast it is", () => {
  const result = report({
    bf16: {
      dev: runSummary({ split: "dev", mean: 0.84 }),
      holdout: runSummary({ split: "holdout", mean: 0.8 }),
      throughput: throughput(6.25, 900),
    },
    fp8: {
      dev: runSummary({ split: "dev", mean: 0.84, forbidden: 3 }),
      holdout: runSummary({ split: "holdout", mean: 0.8 }),
      throughput: throughput(6.25, 3000),
    },
  });

  assert.equal(result.recommended_precision, "bf16");
  const fp8 = result.lanes.find((lane) => lane.precision === "fp8");
  assert.deepEqual(fp8.breaches, ["dev forbidden writes +3"]);
});

test("lanes scored against different split hashes are never compared", () => {
  assert.throws(
    () =>
      report({
        bf16: {
          dev: runSummary({ split: "dev", mean: 0.84 }),
          holdout: runSummary({ split: "holdout", mean: 0.8 }),
          throughput: throughput(6.25, 900),
        },
        fp8: {
          dev: runSummary({ split: "dev", mean: 0.84, sha: "d".repeat(64) }),
          holdout: runSummary({ split: "holdout", mean: 0.8 }),
          throughput: throughput(6.25, 1400),
        },
      }),
    /different dev split/,
  );
});

test("a lane with no measured throughput cannot be recommended", () => {
  const result = report({
    bf16: {
      dev: runSummary({ split: "dev", mean: 0.84 }),
      holdout: runSummary({ split: "holdout", mean: 0.8 }),
      throughput: throughput(6.25, 900),
    },
    fp8: {
      dev: runSummary({ split: "dev", mean: 0.84 }),
      holdout: runSummary({ split: "holdout", mean: 0.8 }),
      throughput: { gpu: "B200", gpu_usd_per_hour: null, peak_output_tokens_per_s: null },
    },
  });

  assert.equal(result.recommended_precision, "bf16");
});
