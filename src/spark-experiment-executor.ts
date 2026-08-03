import { createHash } from "node:crypto";

import { z } from "zod";
import {
  ExperimentSubmitRequestSchema,
  type ExperimentSubmitRequest,
} from "./experiment-executor.js";

/**
 * Spark executor boundary for the unified experiment Workflow.
 *
 * The Workflow owns the run lifecycle, retries and state. This module is an
 * executor adapter only: it validates `understudy.executor-submit.v1`, derives
 * a deterministic idempotency key, hands the request to a backend and returns
 * a job reference immediately. It never polls, never schedules and never
 * persists run state of its own.
 */

export const EXECUTOR_SUBMIT_SCHEMA = "understudy.executor-submit.v1" as const;

const ExecutorNameSchema = z.enum(["modal", "wafer", "fireworks", "spark", "fixture"]);
const RefSchema = z.string().min(1).max(1024);
const TimestampSchema = z.string().datetime({ offset: true });

export const ExecutorJobRefSchema = z
  .object({
    executor: ExecutorNameSchema,
    job_id: z.string().min(1).max(500),
    idempotency_key: z.string().min(1).max(500),
    submitted_at: TimestampSchema,
  })
  .strict();

export const ExecutorJobStatusSchema = z
  .object({
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    observed_at: TimestampSchema,
    artifact_refs: z.array(RefSchema).max(256).default([]),
    failure_code: z.string().min(1).max(160).optional(),
  })
  .strict();

export const ExecutorCancellationReceiptSchema = z
  .object({
    job: ExecutorJobRefSchema,
    disposition: z.enum(["cancelled", "already_terminal", "not_found"]),
    observed_at: TimestampSchema,
  })
  .strict();

const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const AmountSchema = z.number().min(0).nullable();

export const ExecutorUsageReceiptSchema = z
  .object({
    evidence_scope: z.enum(["run_exclusive", "account_window", "unknown"]),
    requests: CountSchema,
    input_tokens: CountSchema,
    output_tokens: CountSchema,
    actual_usd: AmountSchema,
    estimated_usd: AmountSchema,
    upper_bound_usd: AmountSchema,
    observed_at: TimestampSchema,
  })
  .strict();

export type ExecutorJobRef = z.infer<typeof ExecutorJobRefSchema>;
export type ExecutorJobStatus = z.infer<typeof ExecutorJobStatusSchema>;
export type ExecutorCancellationReceipt = z.infer<typeof ExecutorCancellationReceiptSchema>;
export type ExecutorUsageReceipt = z.infer<typeof ExecutorUsageReceiptSchema>;
export type EvidenceScope = ExecutorUsageReceipt["evidence_scope"];

/**
 * Derive the retry-stable job identity. A retry of the same attempt reuses the
 * key, so the backend can return the existing job instead of starting a second
 * paid one. A new attempt is a new key and therefore a new job.
 */
export function idempotencyKeyFor(request: ExperimentSubmitRequest): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        EXECUTOR_SUBMIT_SCHEMA,
        request.experiment_id,
        request.candidate.candidate_id,
        request.attempt,
      ]),
    )
    .digest("hex");
  return `spark:${digest}`;
}

export type SparkBackendStart = {
  idempotency_key: string;
  request: ExperimentSubmitRequest;
};

export type SparkBackendUsage = {
  evidence_scope: EvidenceScope;
  requests: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  actual_usd: number | null;
  estimated_usd: number | null;
  upper_bound_usd: number | null;
};

/**
 * The serving-side adapter. Implementations must treat `idempotency_key` as
 * the job identity: a repeated start with the same key returns the job that
 * already exists rather than launching a second one.
 */
export type SparkBackend = {
  start(input: SparkBackendStart): Promise<{ job_id: string }>;
  probe(job_id: string): Promise<Omit<ExecutorJobStatus, "observed_at">>;
  cancel(job_id: string): Promise<ExecutorCancellationReceipt["disposition"]>;
  usage(job_id: string): Promise<SparkBackendUsage>;
};

export type SparkExecutorOptions = {
  now?: () => Date;
};

export class SparkExperimentExecutor {
  readonly #backend: SparkBackend;
  readonly #now: () => Date;
  /** Retry fast path only; the backend remains the authority on job identity. */
  readonly #submitted = new Map<string, ExecutorJobRef>();

  constructor(backend: SparkBackend, options: SparkExecutorOptions = {}) {
    this.#backend = backend;
    this.#now = options.now ?? (() => new Date());
  }

  #timestamp(): string {
    return this.#now().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  async submit(request: unknown): Promise<ExecutorJobRef> {
    const parsed = ExperimentSubmitRequestSchema.parse(request);
    if (parsed.candidate.executor !== "spark") {
      throw new Error(`spark executor received candidate for executor "${parsed.candidate.executor}"`);
    }
    const idempotency_key = idempotencyKeyFor(parsed);
    const existing = this.#submitted.get(idempotency_key);
    if (existing) return existing;
    const { job_id } = await this.#backend.start({ idempotency_key, request: parsed });
    const ref = ExecutorJobRefSchema.parse({
      executor: "spark",
      job_id,
      idempotency_key,
      submitted_at: this.#timestamp(),
    });
    this.#submitted.set(idempotency_key, ref);
    return ref;
  }

  async inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus> {
    const ref = ExecutorJobRefSchema.parse(job);
    const observed = await this.#backend.probe(ref.job_id);
    return ExecutorJobStatusSchema.parse({ ...observed, observed_at: this.#timestamp() });
  }

  async cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt> {
    const ref = ExecutorJobRefSchema.parse(job);
    const disposition = await this.#backend.cancel(ref.job_id);
    return ExecutorCancellationReceiptSchema.parse({
      job: ref,
      disposition,
      observed_at: this.#timestamp(),
    });
  }

  /**
   * Usage is whatever the adapter can actually evidence. `evidence_scope`
   * comes from the adapter — a shared Spark node that also serves other work
   * reports `account_window`, not `run_exclusive`.
   */
  async reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt> {
    const ref = ExecutorJobRefSchema.parse(job);
    const usage = await this.#backend.usage(ref.job_id);
    return ExecutorUsageReceiptSchema.parse({ ...usage, observed_at: this.#timestamp() });
  }
}
