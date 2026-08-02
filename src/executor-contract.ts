import { createHash } from "node:crypto";
import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const DateTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "expected date-time");

export const EXECUTOR_SUBMIT_SCHEMA = "understudy.executor-submit.v1" as const;
export const EXECUTORS = ["modal", "wafer", "fireworks", "spark", "fixture"] as const;
export const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const CANCELLATION_DISPOSITIONS = ["cancelled", "already_terminal", "not_found"] as const;
export const USAGE_EVIDENCE_SCOPES = ["run_exclusive", "account_window", "unknown"] as const;

export const ExecutorSubmitRequestSchema = z.object({
  schema_version: z.literal(EXECUTOR_SUBMIT_SCHEMA),
  experiment_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  candidate: z.object({
    candidate_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    executor: z.enum(EXECUTORS),
    model: z.string().min(1).max(500),
    model_revision: z.string().min(1).max(240).optional(),
    policy_ref: z.string().min(1).max(1024),
    policy_sha256: Sha256,
  }).strict(),
  attempt: z.number().int().min(0).max(1000),
  workload: z.object({
    id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    dataset_manifest_ref: z.string().min(1).max(1024),
    dataset_manifest_sha256: Sha256,
    verifier_environment: z.string().min(1).max(500),
    verifier_revision: z.string().min(1).max(240),
  }).strict(),
  splits: z.object({
    train_manifest_ref: z.string().min(1).max(1024),
    train_manifest_sha256: Sha256,
    dev_manifest_ref: z.string().min(1).max(1024),
    dev_manifest_sha256: Sha256,
  }).strict(),
  limits: z.object({
    budget_usd: z.number().min(0).max(100000),
    max_concurrent_candidates: z.number().int().min(1).max(128),
    max_concurrent_requests_per_candidate: z.number().int().min(1).max(1024),
    max_rollouts: z.number().int().min(1).max(1_000_000),
    max_runtime_seconds: z.number().int().min(1).max(604800),
  }).strict(),
}).strict();

export const ExecutorJobRefSchema = z.object({
  executor: z.enum(EXECUTORS),
  job_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(500),
  submitted_at: DateTime,
}).strict();

export const ExecutorJobStatusSchema = z.object({
  state: z.enum(JOB_STATES),
  observed_at: DateTime,
  artifact_refs: z.array(z.string().min(1).max(1024)).max(256).optional(),
  failure_code: z.string().min(1).max(160).optional(),
}).strict();

export const ExecutorCancellationReceiptSchema = z.object({
  job: ExecutorJobRefSchema,
  disposition: z.enum(CANCELLATION_DISPOSITIONS),
  observed_at: DateTime,
}).strict();

export const ExecutorUsageReceiptSchema = z.object({
  evidence_scope: z.enum(USAGE_EVIDENCE_SCOPES),
  requests: z.number().int().min(0).nullable(),
  input_tokens: z.number().int().min(0).nullable(),
  output_tokens: z.number().int().min(0).nullable(),
  actual_usd: z.number().min(0).nullable(),
  estimated_usd: z.number().min(0).nullable(),
  upper_bound_usd: z.number().min(0).nullable(),
  observed_at: DateTime,
}).strict();

export type ExecutorSubmitRequest = z.infer<typeof ExecutorSubmitRequestSchema>;
export type ExecutorJobRef = z.infer<typeof ExecutorJobRefSchema>;
export type ExecutorJobStatus = z.infer<typeof ExecutorJobStatusSchema>;
export type ExecutorCancellationReceipt = z.infer<typeof ExecutorCancellationReceiptSchema>;
export type ExecutorUsageReceipt = z.infer<typeof ExecutorUsageReceiptSchema>;

export interface ExecutorAdapter {
  submit(request: ExecutorSubmitRequest): Promise<ExecutorJobRef>;
  inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus>;
  cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt>;
  reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt>;
}

type FixtureJob = {
  ref: ExecutorJobRef;
  status: ExecutorJobStatus;
  usage: ExecutorUsageReceipt;
};

export type FixtureExecutorOptions = {
  now?: () => string;
  usage?: Partial<Omit<ExecutorUsageReceipt, "evidence_scope" | "observed_at">>;
  evidence_scope?: ExecutorUsageReceipt["evidence_scope"];
};

/**
 * The published contract currently has no "tinker" executor enum member.
 * This fixture adapter is intentionally the only truthful implementation for
 * the local contract tests; a Tinker adapter must wait for the contract gap to
 * be resolved rather than mislabeling the job.
 */
export function createFixtureExecutor(options: FixtureExecutorOptions = {}): ExecutorAdapter {
  const jobs = new Map<string, FixtureJob>();
  const now = options.now ?? (() => new Date().toISOString());
  const evidenceScope = options.evidence_scope ?? "unknown";

  return {
    async submit(input) {
      const request = ExecutorSubmitRequestSchema.parse(input);
      if (request.candidate.executor !== "fixture") {
        throw new Error("fixture adapter requires candidate.executor=fixture");
      }
      const idempotencyKey = deterministicExecutorIdempotencyKey(request);
      const existing = jobs.get(idempotencyKey);
      if (existing) return existing.ref;
      const submittedAt = now();
      const ref = ExecutorJobRefSchema.parse({
        executor: "fixture",
        job_id: `fixture-${idempotencyKey.slice(0, 32)}`,
        idempotency_key: idempotencyKey,
        submitted_at: submittedAt,
      });
      const status = ExecutorJobStatusSchema.parse({ state: "queued", observed_at: submittedAt });
      const usage = ExecutorUsageReceiptSchema.parse({
        evidence_scope: evidenceScope,
        requests: options.usage?.requests ?? null,
        input_tokens: options.usage?.input_tokens ?? null,
        output_tokens: options.usage?.output_tokens ?? null,
        actual_usd: options.usage?.actual_usd ?? null,
        estimated_usd: options.usage?.estimated_usd ?? null,
        upper_bound_usd: options.usage?.upper_bound_usd ?? null,
        observed_at: submittedAt,
      });
      jobs.set(idempotencyKey, { ref, status, usage });
      return ref;
    },
    async inspect(job) {
      const found = findJob(jobs, job);
      return ExecutorJobStatusSchema.parse({ ...found.status, observed_at: now() });
    },
    async cancel(job) {
      const found = jobs.get(job.idempotency_key);
      if (!found || found.ref.job_id !== job.job_id) {
        return ExecutorCancellationReceiptSchema.parse({
          job: ExecutorJobRefSchema.parse(job),
          disposition: "not_found",
          observed_at: now(),
        });
      }
      const terminal = ["succeeded", "failed", "cancelled"].includes(found.status.state);
      const disposition = terminal ? "already_terminal" : "cancelled";
      if (!terminal) found.status = { ...found.status, state: "cancelled" };
      return ExecutorCancellationReceiptSchema.parse({
        job: found.ref,
        disposition,
        observed_at: now(),
      });
    },
    async reconcileUsage(job) {
      const found = findJob(jobs, job);
      return ExecutorUsageReceiptSchema.parse({ ...found.usage, observed_at: now() });
    },
  };
}

export function deterministicExecutorIdempotencyKey(
  input: Pick<ExecutorSubmitRequest, "experiment_id" | "candidate" | "attempt">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([input.experiment_id, input.candidate.candidate_id, input.attempt]))
    .digest("hex");
}

function findJob(jobs: Map<string, FixtureJob>, job: ExecutorJobRef): FixtureJob {
  const found = jobs.get(job.idempotency_key);
  if (!found || found.ref.job_id !== job.job_id) throw new Error("executor job not found");
  return found;
}
