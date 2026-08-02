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

export type ExperimentJob = {
  jobId: string;
  idempotencyKey: string;
  status: string;
};

export type UsageEvidence = "run-exclusive" | "estimated";

export type ExperimentUsage = {
  evidence_scope: UsageEvidence;
  gpuSeconds: number | null;
  actual_usd?: number | null;
  estimated_usd?: number | null;
};

export interface ExperimentExecutor {
  submit(request: ExperimentRequest): Promise<ExperimentJob>;
  inspect(jobId: string): Promise<ExperimentJob>;
  cancel(jobId: string): Promise<{
    jobId: string;
    status: "cancelled";
    cancelledAt: string;
  }>;
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
    }) as Promise<ExperimentJob>;
  }

  async inspect(jobId: string): Promise<ExperimentJob> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}`, {
      method: "GET",
    }) as Promise<ExperimentJob>;
  }

  async cancel(jobId: string): Promise<{
    jobId: string;
    status: "cancelled";
    cancelledAt: string;
  }> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }) as Promise<{
      jobId: string;
      status: "cancelled";
      cancelledAt: string;
    }>;
  }

  async reconcileUsage(
    jobId: string,
  ): Promise<ExperimentUsage> {
    return this.request(`/experiments/${encodeURIComponent(jobId)}/usage`, {
      method: "GET",
    }) as Promise<ExperimentUsage>;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
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
    return response.status === 204 ? undefined : response.json();
  }
}
