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

export const ExperimentJobSchema = z.object({
  job: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
}).strict();

export type ExperimentJob = z.infer<typeof ExperimentJobSchema>;

export const ExperimentCancellationSchema = z.object({
  job: z.string().min(1),
  disposition: z.literal("cancelled"),
  observed_at: z.string().min(1),
}).strict();

export type ExperimentCancellation = z.infer<typeof ExperimentCancellationSchema>;

export type UsageEvidence = "run_exclusive" | "account_window" | "unknown";

export const ExperimentUsageSchema = z.object({
  job: z.string().min(1),
  evidence_scope: z.enum(["run_exclusive", "account_window", "unknown"]),
  actual_usd: z.number().nullable(),
  estimated_usd: z.number().nullable(),
  requests: z.number().nullable(),
  tokens: z.number().nullable(),
  gpu_seconds: z.number().nullable(),
}).strict();

export type ExperimentUsage = z.infer<typeof ExperimentUsageSchema>;

export interface ExperimentExecutor {
  submit(request: ExperimentRequest): Promise<ExperimentJob>;
  inspect(jobId: string): Promise<ExperimentJob>;
  cancel(jobId: string): Promise<ExperimentCancellation>;
  reconcileUsage(jobId: string): Promise<ExperimentUsage>;
}

export class ModalExperimentExecutor implements ExperimentExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  async submit(request: ExperimentRequest): Promise<ExperimentJob> {
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
    }, ExperimentJobSchema);
  }

  async inspect(jobId: string): Promise<ExperimentJob> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}`, {
      method: "GET",
    }, ExperimentJobSchema);
  }

  async cancel(jobId: string): Promise<ExperimentCancellation> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }, ExperimentCancellationSchema);
  }

  async reconcileUsage(
    jobId: string,
  ): Promise<ExperimentUsage> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}/usage`, {
      method: "GET",
    }, ExperimentUsageSchema);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("authorization", `Bearer ${this.apiKey}`);
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new Error(`experiment executor request failed: ${response.status}`);
    }
    if (response.status === 204) {
      throw new Error("experiment executor returned an empty response");
    }
    return schema.parse(await response.json());
  }
}
