/**
 * Modal quantization-lane executor adapter.
 *
 * An executor surface for the unified Vercel Workflow controller: it turns an
 * `understudy.executor-submit.v1` request into a Modal serving-lane job
 * reference and back, and it implements submit / inspect / cancel /
 * reconcileUsage. It is NOT a controller — it owns no queue, no poller and no
 * state database. The caller (the Workflow) owns run state; this module is a
 * pure translation layer over an injected Modal-side driver.
 *
 * Three properties the tests pin down, because they are the ones that cost
 * money or leak data when they break:
 *
 *   1. Idempotency. The key is a pure function of
 *      (experiment_id, candidate_id, attempt), so a Workflow retry re-attaches
 *      to the job it already paid for instead of starting a second GPU.
 *   2. Holdout isolation. The submit contract has no holdout field, and this
 *      adapter refuses any request that smuggles one in.
 *   3. Refs and hashes only. No prompts, traces, labels, weights or credentials
 *      cross the boundary — the candidate is identified by
 *      (model, revision, policy hash), the data by manifest refs and hashes.
 *
 * The serving lane it submits to is defined by `modal_serve_quant.py`
 * (Nemotron-3-Nano at BF16 / FP8 / NVFP4 behind vLLM). Nothing here calls Modal:
 * the driver is injected, so the adapter is exercised entirely by tests.
 */
import { createHash } from "node:crypto";

export const SUBMIT_SCHEMA_VERSION = "understudy.executor-submit.v1";
export const EXECUTOR = "modal";

/** Precision lanes this executor can serve, and the flag that selects each. */
export const PRECISION_LANES = Object.freeze({
  bf16: { web_function: "serve_bf16", weight_dtype: "bfloat16", kv_cache_dtype: "auto" },
  fp8: { web_function: "serve_fp8", weight_dtype: "fp8", kv_cache_dtype: "auto" },
  nvfp4: { web_function: "serve_nvfp4", weight_dtype: "nvfp4", kv_cache_dtype: "fp8" },
});

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Mirrors the canonical schema's `additionalProperties: false`. Anything the
// controller has not published is rejected rather than silently forwarded.
const SUBMIT_KEYS = ["schema_version", "experiment_id", "candidate", "attempt", "workload", "splits", "limits"];
const CANDIDATE_KEYS = ["candidate_id", "executor", "model", "model_revision", "policy_ref", "policy_sha256"];
const CANDIDATE_REQUIRED = ["candidate_id", "executor", "model", "policy_ref", "policy_sha256"];
const WORKLOAD_KEYS = [
  "id",
  "dataset_manifest_ref",
  "dataset_manifest_sha256",
  "verifier_environment",
  "verifier_revision",
];
const SPLIT_KEYS = ["train_manifest_ref", "train_manifest_sha256", "dev_manifest_ref", "dev_manifest_sha256"];
const LIMIT_KEYS = [
  "budget_usd",
  "max_concurrent_candidates",
  "max_concurrent_requests_per_candidate",
  "max_rollouts",
  "max_runtime_seconds",
];

export class ExecutorContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExecutorContractError";
  }
}

const fail = (message) => {
  throw new ExecutorContractError(message);
};

const requireObject = (value, path) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
};

function requireExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not part of ${SUBMIT_SCHEMA_VERSION}`);
  }
}

function requirePresent(value, keys, path) {
  for (const key of keys) {
    if (value[key] === undefined || value[key] === null || value[key] === "") fail(`${path}.${key} is required`);
  }
}

function requireInteger(value, path, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${path} must be an integer in [${min}, ${max}]`);
  }
}

/**
 * Validate a submit request against the canonical contract.
 *
 * Deliberately strict about holdout: the schema has no holdout field, so any
 * key mentioning it is a structural violation, not an unknown-field warning.
 */
export function validateSubmitRequest(request) {
  requireObject(request, "request");
  requireExactKeys(request, SUBMIT_KEYS, "request");
  requirePresent(request, SUBMIT_KEYS, "request");

  if (request.schema_version !== SUBMIT_SCHEMA_VERSION) {
    fail(`schema_version must be ${SUBMIT_SCHEMA_VERSION}`);
  }
  if (!ID_RE.test(request.experiment_id)) fail("experiment_id is malformed");
  requireInteger(request.attempt, "request.attempt", { min: 0, max: 1000 });

  const candidate = requireObject(request.candidate, "request.candidate");
  requireExactKeys(candidate, CANDIDATE_KEYS, "request.candidate");
  requirePresent(candidate, CANDIDATE_REQUIRED, "request.candidate");
  if (!ID_RE.test(candidate.candidate_id)) fail("candidate.candidate_id is malformed");
  if (candidate.executor !== EXECUTOR) fail(`candidate.executor must be ${EXECUTOR} for this adapter`);
  if (!SHA256_RE.test(candidate.policy_sha256)) fail("candidate.policy_sha256 must be a sha256 hex digest");

  const workload = requireObject(request.workload, "request.workload");
  requireExactKeys(workload, WORKLOAD_KEYS, "request.workload");
  requirePresent(workload, WORKLOAD_KEYS, "request.workload");
  if (!SHA256_RE.test(workload.dataset_manifest_sha256)) {
    fail("workload.dataset_manifest_sha256 must be a sha256 hex digest");
  }

  const splits = requireObject(request.splits, "request.splits");
  requireExactKeys(splits, SPLIT_KEYS, "request.splits");
  requirePresent(splits, SPLIT_KEYS, "request.splits");
  for (const key of ["train_manifest_sha256", "dev_manifest_sha256"]) {
    if (!SHA256_RE.test(splits[key])) fail(`splits.${key} must be a sha256 hex digest`);
  }

  const limits = requireObject(request.limits, "request.limits");
  requireExactKeys(limits, LIMIT_KEYS, "request.limits");
  requirePresent(limits, LIMIT_KEYS, "request.limits");
  if (typeof limits.budget_usd !== "number" || limits.budget_usd < 0) fail("limits.budget_usd must be >= 0");
  requireInteger(limits.max_concurrent_candidates, "limits.max_concurrent_candidates", { min: 1, max: 128 });
  requireInteger(limits.max_concurrent_requests_per_candidate, "limits.max_concurrent_requests_per_candidate", {
    min: 1,
    max: 1024,
  });
  requireInteger(limits.max_rollouts, "limits.max_rollouts", { min: 1, max: 1_000_000 });
  requireInteger(limits.max_runtime_seconds, "limits.max_runtime_seconds", { min: 1, max: 604_800 });

  return request;
}

/** Canonical JSON: sorted keys, so an equal policy always hashes equal. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");

/**
 * Hash of the serving policy: everything that changes what the GPU computes.
 * Two lanes that differ only in precision therefore get different hashes, and
 * two runs of the same lane get the same hash.
 */
export function policySha256(policy) {
  return sha256Hex(canonicalJson(policy));
}

/**
 * Deterministic idempotency key over (experiment, candidate, attempt).
 *
 * Nothing time-based or random may enter this: a retried Workflow step must
 * derive the identical key and get back the job it already started.
 */
export function idempotencyKey({ experiment_id, candidate_id, attempt }) {
  if (!experiment_id || !candidate_id) fail("idempotencyKey needs experiment_id and candidate_id");
  requireInteger(attempt, "attempt", { min: 0, max: 1000 });
  return sha256Hex(`${EXECUTOR}\u0000${experiment_id}\u0000${candidate_id}\u0000${attempt}`);
}

/** The precision lane a candidate names, derived from its model id. */
export function laneForModel(model) {
  const match = /-(bf16|fp8|nvfp4)$/i.exec(model);
  if (!match) fail(`model ${model} does not name a known precision lane`);
  return match[1].toLowerCase();
}

/**
 * Modal executor adapter.
 *
 * @param {object} driver - injected Modal-side operations:
 *   findJob(idempotencyKey) -> job|null, startJob({...}) -> job,
 *   describeJob(jobId) -> {state, artifact_refs?, failure_code?},
 *   stopJob(jobId) -> {stopped: boolean}, usage(jobId) -> {...}|null
 * @param {() => Date} now - clock, injected so receipts are testable.
 */
export function createModalQuantExecutor(driver, now = () => new Date()) {
  const timestamp = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");

  /**
   * Submit is idempotent: an existing job for the key is returned untouched,
   * so a retry can never start a second paid GPU lane.
   */
  async function submit(request) {
    validateSubmitRequest(request);
    const key = idempotencyKey({
      experiment_id: request.experiment_id,
      candidate_id: request.candidate.candidate_id,
      attempt: request.attempt,
    });

    const existing = await driver.findJob(key);
    if (existing) {
      return { executor: EXECUTOR, job_id: existing.job_id, idempotency_key: key, submitted_at: existing.submitted_at };
    }

    const lane = laneForModel(request.candidate.model);
    const started = await driver.startJob({
      idempotency_key: key,
      web_function: PRECISION_LANES[lane].web_function,
      model: request.candidate.model,
      model_revision: request.candidate.model_revision ?? null,
      policy_ref: request.candidate.policy_ref,
      policy_sha256: request.candidate.policy_sha256,
      dataset_manifest_ref: request.workload.dataset_manifest_ref,
      dev_manifest_ref: request.splits.dev_manifest_ref,
      dev_manifest_sha256: request.splits.dev_manifest_sha256,
      max_concurrent_requests: request.limits.max_concurrent_requests_per_candidate,
      max_runtime_seconds: request.limits.max_runtime_seconds,
      budget_usd: request.limits.budget_usd,
    });

    return {
      executor: EXECUTOR,
      job_id: started.job_id,
      idempotency_key: key,
      submitted_at: started.submitted_at ?? timestamp(),
    };
  }

  async function inspect(jobRef) {
    const described = await driver.describeJob(jobRef.job_id);
    if (!described) return { state: "failed", failure_code: "job_not_found", observed_at: timestamp() };
    const status = { state: described.state, observed_at: timestamp() };
    if (described.artifact_refs) status.artifact_refs = described.artifact_refs;
    if (described.failure_code) status.failure_code = described.failure_code;
    return status;
  }

  /** Cancellation always produces a receipt, including when nothing was cancelled. */
  async function cancel(jobRef) {
    const described = await driver.describeJob(jobRef.job_id);
    let disposition = "not_found";
    if (described) {
      const terminal = ["succeeded", "failed", "cancelled"].includes(described.state);
      if (terminal) disposition = "already_terminal";
      else disposition = (await driver.stopJob(jobRef.job_id)).stopped ? "cancelled" : "already_terminal";
    }
    return { job: jobRef, disposition, observed_at: timestamp() };
  }

  /**
   * Usage is reported with its evidence scope rather than a hardcoded one: a
   * GPU-hour figure that includes a neighbouring app's containers is
   * `account_window`, not proof of this run's spend.
   */
  async function reconcileUsage(jobRef) {
    const usage = (await driver.usage(jobRef.job_id)) ?? {};
    return {
      evidence_scope: usage.evidence_scope ?? "unknown",
      requests: usage.requests ?? null,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      actual_usd: usage.actual_usd ?? null,
      estimated_usd: usage.estimated_usd ?? null,
      upper_bound_usd: usage.upper_bound_usd ?? null,
      observed_at: timestamp(),
    };
  }

  return { submit, inspect, cancel, reconcileUsage };
}
