import { z } from "zod";

export type ArtifactRef = {
  uri: string;
  sha256: string;
};

// Derived from schemas/understudy.executor-submit.v1.schema.json, vendored
// from understudy-platform commit 585d8e1.
export const ExperimentSubmitRequestSchema = z.object({
  experimentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  candidate: z.object({
    candidateId: z.string().min(1),
    model: z.string().min(1),
    modelRevision: z.string().min(1).optional(),
    policyRef: z.string().min(1),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/i),
  }).strict(),
  attempt: z.number().int().nonnegative(),
  workload: z.object({
    id: z.string().min(1),
    datasetManifestRef: z.string().min(1),
    datasetManifestSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    verifierEnvironment: z.string().min(1),
    verifierRevision: z.string().min(1),
  }).strict(),
  splits: z.object({
    trainManifestRef: z.string().min(1),
    devManifestRef: z.string().min(1),
  }).strict(),
  limits: z.object({
    budgetUsd: z.number().nonnegative(),
    maxConcurrentCandidates: z.number().int().positive(),
    maxConcurrentRequestsPerCandidate: z.number().int().positive(),
    maxRollouts: z.number().int().positive(),
    maxRuntimeSeconds: z.number().int().positive(),
  }).strict(),
}).strict();

export type ExperimentSubmitRequest = z.infer<typeof ExperimentSubmitRequestSchema>;
export type ExperimentCandidate = ExperimentSubmitRequest["candidate"];
export type ExperimentWorkload = ExperimentSubmitRequest["workload"];
export type ExperimentSplits = ExperimentSubmitRequest["splits"];
export type ExperimentLimits = ExperimentSubmitRequest["limits"];
export type ExperimentRequest = Omit<ExperimentSubmitRequest, "idempotencyKey">;

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
    const idempotencyKey = `${request.experimentId}:${request.candidate.candidateId}:${request.attempt}`;
    ExperimentSubmitRequestSchema.parse({ ...request, idempotencyKey });
    return this.request("/experiments", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...request, idempotencyKey }),
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
