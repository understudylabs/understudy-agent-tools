import { z } from "zod";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const ExperimentSubmitRequestSchema = z.object({
  schema_version: z.literal("understudy.executor-submit.v1"),
  experiment_id: identifier,
  candidate: z.object({
    candidate_id: identifier,
    executor: z.enum(["modal", "wafer", "fireworks", "spark", "fixture"]),
    model: z.string().min(1).max(500),
    model_revision: z.string().min(1).max(240).optional(),
    policy_ref: z.string().min(1).max(1024),
    policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  attempt: z.number().int().min(0).max(1000),
  workload: z.object({
    id: identifier,
    dataset_manifest_ref: z.string().min(1).max(1024),
    dataset_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifier_environment: z.string().min(1).max(500),
    verifier_revision: z.string().min(1).max(240),
  }).strict(),
  splits: z.object({
    train_manifest_ref: z.string().min(1).max(1024),
    train_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dev_manifest_ref: z.string().min(1).max(1024),
    dev_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  limits: z.object({
    budget_usd: z.number().min(0).max(100000),
    max_concurrent_candidates: z.number().int().min(1).max(128),
    max_concurrent_requests_per_candidate: z.number().int().min(1).max(1024),
    max_rollouts: z.number().int().min(1).max(1000000),
    max_runtime_seconds: z.number().int().min(1).max(604800),
  }).strict(),
}).strict();

export type ExperimentSubmitRequest = z.infer<typeof ExperimentSubmitRequestSchema>;
export type ExperimentRequest = Omit<ExperimentSubmitRequest, "schema_version">;

const rfc3339 = z.string().datetime({ offset: true });

export const ExecutorJobRefSchema = z.object({
  executor: z.enum(["modal", "wafer", "fireworks", "spark", "fixture"]),
  job_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(500),
  submitted_at: rfc3339,
}).strict();

export type ExecutorJobRef = z.infer<typeof ExecutorJobRefSchema>;

export const ExecutorJobStatusSchema = z.object({
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  observed_at: rfc3339,
  artifact_refs: z.array(z.string().min(1).max(1024)).max(256).default([]),
  failure_code: z.string().min(1).max(160).optional(),
}).strict();

export type ExecutorJobStatus = z.infer<typeof ExecutorJobStatusSchema>;

export const ExecutorCancellationReceiptSchema = z.object({
  job: ExecutorJobRefSchema,
  disposition: z.enum(["cancelled", "already_terminal", "not_found"]),
  observed_at: rfc3339,
}).strict();

export type ExecutorCancellationReceipt = z.infer<typeof ExecutorCancellationReceiptSchema>;

export const ExecutorUsageReceiptSchema = z.object({
  evidence_scope: z.enum(["run_exclusive", "account_window", "unknown"]),
  requests: z.number().int().nonnegative().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  actual_usd: z.number().nonnegative().nullable(),
  estimated_usd: z.number().nonnegative().nullable(),
  upper_bound_usd: z.number().nonnegative().nullable(),
  observed_at: rfc3339,
}).strict();

export type ExecutorUsageReceipt = z.infer<typeof ExecutorUsageReceiptSchema>;

export interface ExperimentExecutor {
  submit(request: ExperimentRequest): Promise<ExecutorJobRef>;
  inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus>;
  cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt>;
  reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt>;
}

export class ModalExperimentExecutor implements ExperimentExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!baseUrl.trim()) throw new Error("Modal executor base URL is required.");
    if (!apiKey.trim()) throw new Error("Modal executor bearer token is required.");
  }

  async submit(request: ExperimentRequest): Promise<ExecutorJobRef> {
    const idempotencyKey = `${request.experiment_id}:${request.candidate.candidate_id}:${request.attempt}`;
    const body = {
      schema_version: "understudy.executor-submit.v1" as const,
      ...request,
    };
    ExperimentSubmitRequestSchema.parse(body);
    return this.request("/experiments", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }, ExecutorJobRefSchema);
  }

  async inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus> {
    this.assertModalJob(job);
    return this.request(`/experiments/${encodeURIComponent(job.job_id)}`, {
      method: "GET",
    }, ExecutorJobStatusSchema);
  }

  async cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt> {
    this.assertModalJob(job);
    return this.request(`/experiments/${encodeURIComponent(job.job_id)}`, {
      method: "DELETE",
    }, ExecutorCancellationReceiptSchema);
  }

  async reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt> {
    this.assertModalJob(job);
    return this.request(`/experiments/${encodeURIComponent(job.job_id)}/usage`, {
      method: "GET",
    }, ExecutorUsageReceiptSchema);
  }

  private assertModalJob(job: ExecutorJobRef): void {
    ExecutorJobRefSchema.parse(job);
    if (job.executor !== "modal") {
      throw new Error("Modal executor received a non-Modal job.");
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${this.apiKey}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Modal executor is unavailable.");
    }
    if (!response.ok) {
      throw new Error(`experiment executor request failed: ${response.status}`);
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new Error("Modal executor returned an invalid response.");
    }
  }
}
