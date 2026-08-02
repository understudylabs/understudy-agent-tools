import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

export type Executor = "modal" | "wafer" | "fireworks" | "spark" | "fixture";
export type ExecutorJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type CancellationDisposition = "cancelled" | "already_terminal" | "not_found";
export type EvidenceScope = "run_exclusive" | "account_window" | "unknown";

export type ExecutorSubmitRequest = {
  schema_version: "understudy.executor-submit.v1";
  experiment_id: string;
  candidate: {
    candidate_id: string;
    executor: Executor;
    model: string;
    model_revision?: string;
    policy_ref: string;
    policy_sha256: string;
  };
  attempt: number;
  workload: {
    id: string;
    dataset_manifest_ref: string;
    dataset_manifest_sha256: string;
    verifier_environment: string;
    verifier_revision: string;
  };
  splits: {
    train_manifest_ref: string;
    train_manifest_sha256: string;
    dev_manifest_ref: string;
    dev_manifest_sha256: string;
  };
  limits: {
    budget_usd: number;
    max_concurrent_candidates: number;
    max_concurrent_requests_per_candidate: number;
    max_rollouts: number;
    max_runtime_seconds: number;
  };
};

export type ExecutorJobRef = {
  executor: Executor;
  job_id: string;
  idempotency_key: string;
  submitted_at: string;
};

export type ExecutorJobStatus = {
  state: ExecutorJobState;
  observed_at: string;
  artifact_refs?: string[];
  failure_code?: string;
};

export type ExecutorCancellationReceipt = {
  job: ExecutorJobRef;
  disposition: CancellationDisposition;
  observed_at: string;
};

export type ExecutorUsageReceipt = {
  evidence_scope: EvidenceScope;
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  actual_usd: number | null;
  estimated_usd: number | null;
  upper_bound_usd: number | null;
  observed_at: string;
};

export type UsageAdapter = (job: ExecutorJobRef) => ExecutorUsageReceipt;

type StoredJob = {
  ref: ExecutorJobRef;
  state: ExecutorJobState;
};

const EXECUTORS = new Set<Executor>(["modal", "wafer", "fireworks", "spark", "fixture"]);
const EVIDENCE_SCOPES = new Set<EvidenceScope>(["run_exclusive", "account_window", "unknown"]);
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOP_LEVEL_KEYS = new Set(["schema_version", "experiment_id", "candidate", "attempt", "workload", "splits", "limits"]);
const CANDIDATE_KEYS = new Set(["candidate_id", "executor", "model", "model_revision", "policy_ref", "policy_sha256"]);
const WORKLOAD_KEYS = new Set(["id", "dataset_manifest_ref", "dataset_manifest_sha256", "verifier_environment", "verifier_revision"]);
const SPLIT_KEYS = new Set(["train_manifest_ref", "train_manifest_sha256", "dev_manifest_ref", "dev_manifest_sha256"]);
const LIMIT_KEYS = new Set([
  "budget_usd",
  "max_concurrent_candidates",
  "max_concurrent_requests_per_candidate",
  "max_rollouts",
  "max_runtime_seconds",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: Set<string>, path: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function requiredString(value: unknown, path: string, errors: string[], pattern?: RegExp, maxLength?: number): value is string {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  if (maxLength !== undefined && value.length > maxLength) errors.push(`${path} exceeds maximum length`);
  if (pattern && !pattern.test(value)) errors.push(`${path} has an invalid format`);
  return true;
}

function requiredObject(value: unknown, path: string, errors: string[]): JsonObject | null {
  if (!isObject(value)) errors.push(`${path} must be an object`);
  return isObject(value) ? value : null;
}

function requiredInteger(value: unknown, path: string, errors: string[], minimum: number, maximum: number): value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    errors.push(`${path} must be an integer between ${minimum} and ${maximum}`);
    return false;
  }
  return true;
}

function requiredNumber(value: unknown, path: string, errors: string[], minimum: number, maximum: number): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${path} must be a number between ${minimum} and ${maximum}`);
    return false;
  }
  return true;
}

function rejectHoldoutFields(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectHoldoutFields(entry, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/holdout/i.test(key)) errors.push(`${path}.${key} is not allowed in executor submit payload`);
    rejectHoldoutFields(child, `${path}.${key}`, errors);
  }
}

export function validateExecutorSubmitRequest(input: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(input)) return ["request must be a JSON object"];
  hasOnlyKeys(input, TOP_LEVEL_KEYS, "request", errors);
  if (input.schema_version !== "understudy.executor-submit.v1") errors.push("schema_version is invalid");
  requiredString(input.experiment_id, "experiment_id", errors, IDENTIFIER, 160);
  requiredInteger(input.attempt, "attempt", errors, 0, 1000);

  const candidate = requiredObject(input.candidate, "candidate", errors);
  if (candidate) {
    hasOnlyKeys(candidate, CANDIDATE_KEYS, "candidate", errors);
    requiredString(candidate.candidate_id, "candidate.candidate_id", errors, IDENTIFIER, 160);
    if (!EXECUTORS.has(candidate.executor as Executor)) errors.push("candidate.executor is invalid");
    requiredString(candidate.model, "candidate.model", errors, undefined, 500);
    if (candidate.model_revision !== undefined) requiredString(candidate.model_revision, "candidate.model_revision", errors, undefined, 240);
    requiredString(candidate.policy_ref, "candidate.policy_ref", errors, undefined, 1024);
    requiredString(candidate.policy_sha256, "candidate.policy_sha256", errors, SHA256);
  }

  const workload = requiredObject(input.workload, "workload", errors);
  if (workload) {
    hasOnlyKeys(workload, WORKLOAD_KEYS, "workload", errors);
    requiredString(workload.id, "workload.id", errors, IDENTIFIER, 160);
    requiredString(workload.dataset_manifest_ref, "workload.dataset_manifest_ref", errors, undefined, 1024);
    requiredString(workload.dataset_manifest_sha256, "workload.dataset_manifest_sha256", errors, SHA256);
    requiredString(workload.verifier_environment, "workload.verifier_environment", errors, undefined, 500);
    requiredString(workload.verifier_revision, "workload.verifier_revision", errors, undefined, 240);
  }

  const splits = requiredObject(input.splits, "splits", errors);
  if (splits) {
    hasOnlyKeys(splits, SPLIT_KEYS, "splits", errors);
    requiredString(splits.train_manifest_ref, "splits.train_manifest_ref", errors, undefined, 1024);
    requiredString(splits.train_manifest_sha256, "splits.train_manifest_sha256", errors, SHA256);
    requiredString(splits.dev_manifest_ref, "splits.dev_manifest_ref", errors, undefined, 1024);
    requiredString(splits.dev_manifest_sha256, "splits.dev_manifest_sha256", errors, SHA256);
  }

  const limits = requiredObject(input.limits, "limits", errors);
  if (limits) {
    hasOnlyKeys(limits, LIMIT_KEYS, "limits", errors);
    requiredNumber(limits.budget_usd, "limits.budget_usd", errors, 0, 100000);
    requiredInteger(limits.max_concurrent_candidates, "limits.max_concurrent_candidates", errors, 1, 128);
    requiredInteger(limits.max_concurrent_requests_per_candidate, "limits.max_concurrent_requests_per_candidate", errors, 1, 1024);
    requiredInteger(limits.max_rollouts, "limits.max_rollouts", errors, 1, 1000000);
    requiredInteger(limits.max_runtime_seconds, "limits.max_runtime_seconds", errors, 1, 604800);
  }
  rejectHoldoutFields(input, "request", errors);
  return errors;
}

function assertValidSubmitRequest(input: unknown): asserts input is ExecutorSubmitRequest {
  const errors = validateExecutorSubmitRequest(input);
  if (errors.length > 0) throw new Error(`invalid executor submit request: ${errors.join("; ")}`);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

export function idempotencyKeyFor(input: Pick<ExecutorSubmitRequest, "experiment_id" | "candidate" | "attempt">): string {
  return `executor-${stableHash(`${input.experiment_id}:${input.candidate.candidate_id}:${input.attempt}`)}`;
}

export function jobIdFor(idempotencyKey: string): string {
  return `fixture-${stableHash(idempotencyKey).slice(0, 32)}`;
}

export class ExperimentExecutor {
  private readonly jobs = new Map<string, StoredJob>();

  constructor(private readonly usageAdapter: UsageAdapter) {}

  submit(input: ExecutorSubmitRequest): ExecutorJobRef {
    assertValidSubmitRequest(input);
    const idempotencyKey = idempotencyKeyFor(input);
    const existing = this.jobs.get(idempotencyKey);
    if (existing) return existing.ref;
    const ref: ExecutorJobRef = {
      executor: input.candidate.executor,
      job_id: jobIdFor(idempotencyKey),
      idempotency_key: idempotencyKey,
      submitted_at: now(),
    };
    this.jobs.set(idempotencyKey, { ref, state: "queued" });
    return ref;
  }

  inspect(jobRef: ExecutorJobRef): ExecutorJobStatus {
    const record = this.jobs.get(jobRef.idempotency_key);
    if (!record) return { state: "failed", observed_at: now(), artifact_refs: [], failure_code: "job_not_found" };
    return { state: record.state, observed_at: now(), artifact_refs: [] };
  }

  cancel(jobRef: ExecutorJobRef): ExecutorCancellationReceipt {
    const record = this.jobs.get(jobRef.idempotency_key);
    if (!record) return { job: jobRef, disposition: "not_found", observed_at: now() };
    if (record.state === "succeeded" || record.state === "failed" || record.state === "cancelled") {
      return { job: record.ref, disposition: "already_terminal", observed_at: now() };
    }
    record.state = "cancelled";
    return { job: record.ref, disposition: "cancelled", observed_at: now() };
  }

  reconcileUsage(jobRef: ExecutorJobRef): ExecutorUsageReceipt {
    const receipt = this.usageAdapter(jobRef);
    if (!EVIDENCE_SCOPES.has(receipt.evidence_scope)) throw new Error("usage adapter returned an invalid evidence_scope");
    return receipt;
  }
}

export type FrozenCandidate = {
  candidate_id: string;
  policy_sha256: string;
  fixture: string;
  fixture_sha256: string;
  train_split_sha256: string;
  dev_split_sha256: string;
  [key: string]: unknown;
};

export function buildCandidateSubmitRequest(
  candidate: FrozenCandidate,
  options: {
    experimentId?: string;
    attempt?: number;
    model?: string;
    budgetUsd?: number;
    maxRuntimeSeconds?: number;
  } = {},
): ExecutorSubmitRequest {
  const config = (candidate.gepa_config ?? {}) as JsonObject;
  const model = options.model ?? (typeof config.model === "string" ? config.model : "");
  const trainHash = candidate.train_split_sha256;
  const devHash = candidate.dev_split_sha256;
  const fixture = candidate.fixture;
  const fixtureHash = candidate.fixture_sha256;
  const request: ExecutorSubmitRequest = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: options.experimentId ?? "automationbench-v2-gepa",
    candidate: {
      candidate_id: candidate.candidate_id,
      executor: "fixture",
      model,
      policy_ref: `artifact://candidates/${candidate.candidate_id}/best-prompt.txt`,
      policy_sha256: candidate.policy_sha256,
    },
    attempt: options.attempt ?? 0,
    workload: {
      id: fixture,
      dataset_manifest_ref: `fixture://${fixture}/manifest.json`,
      dataset_manifest_sha256: fixtureHash,
      verifier_environment: fixture,
      verifier_revision: fixtureHash,
    },
    splits: {
      train_manifest_ref: `fixture://${fixture}/split/train/${trainHash}`,
      train_manifest_sha256: trainHash,
      dev_manifest_ref: `fixture://${fixture}/split/dev/${devHash}`,
      dev_manifest_sha256: devHash,
    },
    limits: {
      budget_usd: options.budgetUsd ?? 0,
      max_concurrent_candidates: Number(config.concurrency ?? 1),
      max_concurrent_requests_per_candidate: Number(config.concurrency ?? 1),
      max_rollouts: Number(config.max_rollouts ?? 1),
      max_runtime_seconds: options.maxRuntimeSeconds ?? 604800,
    },
  };
  assertValidSubmitRequest(request);
  return request;
}

export function readFrozenCandidate(path: string): FrozenCandidate {
  const candidate = JSON.parse(readFileSync(path, "utf8")) as FrozenCandidate;
  if (!candidate || typeof candidate !== "object") throw new Error("candidate artifact must be an object");
  return candidate;
}

export function emitCandidateSubmitRequest(
  candidatePath: string,
  outputPath: string,
  options: Parameters<typeof buildCandidateSubmitRequest>[1] = {},
): ExecutorSubmitRequest {
  const request = buildCandidateSubmitRequest(readFrozenCandidate(candidatePath), options);
  writeFileSync(outputPath, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}
