import { z } from "zod";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const ExperimentSubmitRequestSchema = z.object({
  schema_version: z.literal("understudy.executor-submit.v1"),
  experiment_id: identifier,
  candidate: z.object({
    candidate_id: identifier,
    executor: z.enum(["modal", "wafer", "fireworks", "spark", "fixture"]),
    model: z.string().min(1).max(500),
    model_revision: z.string().min(1).max(240).optional(),
    policy_ref: z.string().min(1).max(1024),
    policy_sha256: sha256,
  }).strict(),
  attempt: z.number().int().min(0).max(1000),
  workload: z.object({
    id: identifier,
    dataset_manifest_ref: z.string().min(1).max(1024),
    dataset_manifest_sha256: sha256,
    verifier_environment: z.string().min(1).max(500),
    verifier_revision: z.string().min(1).max(240),
  }).strict(),
  splits: z.object({
    train_manifest_ref: z.string().min(1).max(1024),
    train_manifest_sha256: sha256,
    dev_manifest_ref: z.string().min(1).max(1024),
    dev_manifest_sha256: sha256,
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

export const ExecutorJobRefSchema = z.object({
  executor: z.literal("modal"),
  job_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(500),
  submitted_at: timestamp,
}).strict();
export type ExecutorJobRef = z.infer<typeof ExecutorJobRefSchema>;

const ArtifactReferenceSchema = z.string().min(1).max(1024).refine(
  (value) => !value.startsWith("data:") && !value.includes("\n") && !value.includes("\r"),
  "Artifact references must be bounded references, not inline data",
);

export const ExecutorJobStatusSchema = z.object({
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  observed_at: timestamp,
  artifact_refs: z.array(ArtifactReferenceSchema).max(256).default([]),
  failure_code: z.string().min(1).max(160).optional(),
}).strict();
export type ExecutorJobStatus = z.infer<typeof ExecutorJobStatusSchema>;

export const ExecutorCancellationReceiptSchema = z.object({
  job: ExecutorJobRefSchema,
  disposition: z.enum(["cancelled", "already_terminal", "not_found"]),
  observed_at: timestamp,
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
  observed_at: timestamp,
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
  ) {
    if (!baseUrl.trim()) throw new Error("Modal executor base URL is required");
    if (!apiKey.trim()) throw new Error("Modal executor API key is required");
  }

  async submit(request: ExperimentRequest): Promise<ExecutorJobRef> {
    const idempotencyKey = `${request.experiment_id}:${request.candidate.candidate_id}:${request.attempt}`;
    const body = ExperimentSubmitRequestSchema.parse({
      schema_version: "understudy.executor-submit.v1",
      ...request,
    });
    if (body.candidate.executor !== "modal") throw new Error("Modal executor requires executor=modal");
    return this.request("/experiments", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }, ExecutorJobRefSchema);
  }

  async inspect(job: ExecutorJobRef): Promise<ExecutorJobStatus> {
    const parsed = ExecutorJobRefSchema.parse(job);
    return this.request(`/experiments/${encodeURIComponent(parsed.job_id)}`, { method: "GET" }, ExecutorJobStatusSchema);
  }

  async cancel(job: ExecutorJobRef): Promise<ExecutorCancellationReceipt> {
    const parsed = ExecutorJobRefSchema.parse(job);
    return this.request(`/experiments/${encodeURIComponent(parsed.job_id)}`, { method: "DELETE" }, ExecutorCancellationReceiptSchema);
  }

  async reconcileUsage(job: ExecutorJobRef): Promise<ExecutorUsageReceipt> {
    const parsed = ExecutorJobRefSchema.parse(job);
    return this.request(`/experiments/${encodeURIComponent(parsed.job_id)}/usage`, { method: "GET" }, ExecutorUsageReceiptSchema);
  }

  private async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", `Bearer ${this.apiKey}`);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("experiment executor is unavailable");
    }
    if (!response.ok) throw new Error(`experiment executor request failed: ${response.status}`);
    if (response.status === 204) throw new Error("experiment executor returned an empty response");
    try {
      return schema.parse(await response.json());
    } catch {
      throw new Error("experiment executor returned a non-canonical response");
    }
  }
}
