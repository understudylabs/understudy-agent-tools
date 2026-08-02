import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JsonSchema = Record<string, unknown>;
export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

const CONTRACT_DIR = fileURLToPath(
  new URL("../schemas/vendor/understudy-experiment-v1/", import.meta.url),
);

const schemaNames = {
  submit: "experiment-executor-submit-request.json",
  jobRef: "experiment-executor-job-ref.json",
  jobStatus: "experiment-executor-job-status.json",
  cancellation: "experiment-executor-cancellation-receipt.json",
  usage: "experiment-executor-usage-receipt.json",
  event: "experiment-event.json",
  result: "experiment-result.json",
} as const;

export type WorkflowSchemaName = keyof typeof schemaNames;

export function loadWorkflowSchema(name: WorkflowSchemaName): JsonSchema {
  return JSON.parse(readFileSync(`${CONTRACT_DIR}${schemaNames[name]}`, "utf8")) as JsonSchema;
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal const`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} has invalid enum value`);
  if (typeof schema.type === "string" && !typeMatches(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      const candidateErrors: string[] = [];
      validateNode(value, candidate as JsonSchema, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) errors.push(`${path} matches no anyOf branch`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors: string[] = [];
      validateNode(value, candidate as JsonSchema, path, candidateErrors);
      return candidateErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${path} must match exactly one oneOf branch`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has invalid format`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path} is not a date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => validateNode(item, schema.items as JsonSchema, `${path}[${index}]`, errors));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const object = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!(key in object)) errors.push(`${path}.${key} is required`);
    const properties = schema.properties as Record<string, JsonSchema>;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateNode(object[key], child, `${path}.${key}`, errors);
    }
  }
}

export function validateWorkflowContract(value: unknown, schema: JsonSchema): ValidationResult {
  const errors: string[] = [];
  validateNode(value, schema, "$", errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

export interface LadderCell {
  experimentId: string;
  candidateId: string;
  attempt: number;
  model: string;
  checkpointRef: string;
  promptSha256: string;
  workloadId: string;
  datasetManifestRef: string;
  datasetManifestSha256: string;
  verifierEnvironment: string;
  verifierRevision: string;
  trainManifestRef: string;
  trainManifestSha256: string;
  devManifestRef: string;
  devManifestSha256: string;
  budgetUsd: number;
  maxRollouts: number;
  maxRuntimeSeconds: number;
}

export function cellToSubmitPayload(cell: LadderCell): Record<string, unknown> {
  const rawCell = cell as unknown as Record<string, unknown>;
  if (Object.keys(rawCell).some((key) => key.toLowerCase().includes("holdout"))) {
    throw new Error("holdout references are forbidden in executor submit payloads");
  }
  const payload = {
    schema_version: "understudy.executor-submit.v1",
    experiment_id: cell.experimentId,
    candidate: {
      candidate_id: cell.candidateId,
      executor: "fixture",
      model: cell.model,
      model_revision: "nemotron3_disable_thinking",
      policy_ref: cell.checkpointRef,
      policy_sha256: cell.promptSha256,
    },
    attempt: cell.attempt,
    workload: {
      id: cell.workloadId,
      dataset_manifest_ref: cell.datasetManifestRef,
      dataset_manifest_sha256: cell.datasetManifestSha256,
      verifier_environment: cell.verifierEnvironment,
      verifier_revision: cell.verifierRevision,
    },
    splits: {
      train_manifest_ref: cell.trainManifestRef,
      train_manifest_sha256: cell.trainManifestSha256,
      dev_manifest_ref: cell.devManifestRef,
      dev_manifest_sha256: cell.devManifestSha256,
    },
    limits: {
      budget_usd: cell.budgetUsd,
      max_concurrent_candidates: 1,
      max_concurrent_requests_per_candidate: 1,
      max_rollouts: cell.maxRollouts,
      max_runtime_seconds: cell.maxRuntimeSeconds,
    },
  };
  const validation = validateWorkflowContract(payload, loadWorkflowSchema("submit"));
  if (!validation.valid) throw new Error(`invalid executor submit payload: ${validation.errors.join("; ")}`);
  return payload;
}

export interface JobRef {
  executor: "fixture";
  job_id: string;
  idempotency_key: string;
  submitted_at: string;
}

export interface UsageReceipt {
  evidence_scope: "run_exclusive" | "account_window" | "unknown";
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  actual_usd: number | null;
  estimated_usd: number | null;
  upper_bound_usd: number | null;
  observed_at: string;
}

export interface TerminalResultInput {
  experimentId: string;
  verifierEnvironment: string;
  verifierRevision: string;
  trainManifestRef: string;
  trainManifestSha256: string;
  devManifestRef: string;
  devManifestSha256: string;
  holdoutManifestRef: string;
  holdoutManifestSha256: string;
  holdoutExecuted: boolean;
  holdoutClean: boolean | null;
  budgetUsd: number;
  usage: UsageReceipt;
  baselineMetrics: Record<string, number> | null;
  optimizedMetrics: Record<string, number> | null;
  qualityStatus: "not_measured" | "measured" | "invalidated_pending_calibration" | "invalidated_quarantined" | "calibrated";
  qualityReason: string | null;
  requiredCalibration: string | null;
  calibrationArtifactRefs: string[];
  failureClusters: Array<{ cluster: string; count: number; artifact_refs?: string[] }>;
  cancellationReceipts: Record<string, unknown>[];
  artifactRefs: string[];
  claimBoundary: string;
}

export function buildTerminalResult(input: TerminalResultInput): Record<string, unknown> {
  const result = {
    schema_version: "understudy.experiment-result.v1",
    experiment_id: input.experimentId,
    state: input.holdoutExecuted ? "succeeded" : "holdout_locked",
    verifier_environment: input.verifierEnvironment,
    verifier_revision: input.verifierRevision,
    split_manifest_refs: {
      train: input.trainManifestRef,
      dev: input.devManifestRef,
      holdout: input.holdoutManifestRef,
    },
    split_manifest_sha256: {
      train: input.trainManifestSha256,
      dev: input.devManifestSha256,
      holdout: input.holdoutManifestSha256,
    },
    baseline_metrics: input.baselineMetrics,
    optimized_metrics: input.optimizedMetrics,
    holdout_executed: input.holdoutExecuted,
    holdout_clean: input.holdoutClean,
    budget_usd: input.budgetUsd,
    usage: input.usage,
    request_isolation_proven: true,
    quality_evidence: {
      status: input.qualityStatus,
      reason: input.qualityReason,
      required_calibration: input.requiredCalibration,
      calibration_artifact_refs: input.calibrationArtifactRefs,
    },
    failure_clusters: input.failureClusters,
    cancellation_receipts: input.cancellationReceipts,
    artifact_refs: input.artifactRefs,
    claim_boundary: input.claimBoundary,
  };
  const validation = validateWorkflowContract(result, loadWorkflowSchema("result"));
  if (!validation.valid) throw new Error(`invalid experiment result: ${validation.errors.join("; ")}`);
  return result;
}

function stableIdempotencyKey(cell: LadderCell): string {
  const binding = [
    cell.experimentId,
    cell.candidateId,
    cell.attempt,
    cell.trainManifestSha256,
    cell.devManifestSha256,
    cell.promptSha256,
    cell.checkpointRef,
  ].join("\u001f");
  return createHash("sha256").update(binding).digest("hex");
}

export class FixtureExperimentExecutor {
  private readonly jobs = new Map<string, { ref: JobRef; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; usage?: UsageReceipt }>();
  private readonly emittedEvents: Record<string, unknown>[] = [];

  submit(cell: LadderCell): JobRef {
    const payload = cellToSubmitPayload(cell);
    const idempotencyKey = stableIdempotencyKey(cell);
    const existing = this.jobs.get(idempotencyKey);
    if (existing) return existing.ref;
    const ref: JobRef = {
      executor: "fixture",
      job_id: `fixture-${idempotencyKey.slice(0, 24)}`,
      idempotency_key: idempotencyKey,
      submitted_at: new Date(0).toISOString(),
    };
    const validation = validateWorkflowContract(ref, loadWorkflowSchema("jobRef"));
    if (!validation.valid) throw new Error(`invalid job ref: ${validation.errors.join("; ")}`);
    this.jobs.set(idempotencyKey, { ref, state: "queued" });
    void payload;
    return ref;
  }

  inspect(job: JobRef): Record<string, unknown> {
    const entry = [...this.jobs.values()].find((candidate) => candidate.ref.job_id === job.job_id);
    if (!entry) throw new Error(`unknown job ${job.job_id}`);
    const status = { state: entry.state, observed_at: new Date(0).toISOString() };
    const validation = validateWorkflowContract(status, loadWorkflowSchema("jobStatus"));
    if (!validation.valid) throw new Error(`invalid job status: ${validation.errors.join("; ")}`);
    return status;
  }

  cancel(job: JobRef): Record<string, unknown> {
    const entry = [...this.jobs.values()].find((candidate) => candidate.ref.job_id === job.job_id);
    const receipt = {
      job,
      disposition: entry ? (entry.state === "cancelled" ? "already_terminal" : "cancelled") : "not_found",
      observed_at: new Date(0).toISOString(),
    };
    if (entry && entry.state !== "cancelled") entry.state = "cancelled";
    const validation = validateWorkflowContract(receipt, loadWorkflowSchema("cancellation"));
    if (!validation.valid) throw new Error(`invalid cancellation receipt: ${validation.errors.join("; ")}`);
    return receipt;
  }

  reconcileUsage(job: JobRef, usage: UsageReceipt): UsageReceipt {
    const entry = [...this.jobs.values()].find((candidate) => candidate.ref.job_id === job.job_id);
    if (!entry) throw new Error(`unknown job ${job.job_id}`);
    entry.usage = { ...usage };
    const validation = validateWorkflowContract(entry.usage, loadWorkflowSchema("usage"));
    if (!validation.valid) throw new Error(`invalid usage receipt: ${validation.errors.join("; ")}`);
    return { ...entry.usage };
  }

  emitEvent(event: Record<string, unknown>): Record<string, unknown> {
    const serialized = JSON.stringify(event).toLowerCase();
    if (/(prompt|transcript|task_content|credential|secret|weight)/.test(serialized)) {
      throw new Error("event contains redaction-sensitive content");
    }
    const validation = validateWorkflowContract(event, loadWorkflowSchema("event"));
    if (!validation.valid) throw new Error(`invalid experiment event: ${validation.errors.join("; ")}`);
    this.emittedEvents.push(structuredClone(event));
    return event;
  }

  events(): readonly Record<string, unknown>[] {
    return this.emittedEvents;
  }
}

export function eventBase(experimentId: string, sequence: number, type: string): Record<string, unknown> {
  return {
    schema_version: "understudy.experiment-event.v1",
    experiment_id: experimentId,
    sequence,
    occurred_at: new Date(0).toISOString(),
    type,
  };
}
