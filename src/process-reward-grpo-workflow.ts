import { createHash } from "node:crypto";

export const PROCESS_REWARD_GRPO_WORKFLOW_SCHEMA =
  "understudy.process_reward_grpo.workflow.v1" as const;

export type ArtifactRef = {
  uri: string;
  sha256: string;
};

export type ExecutorSubmitRequest = {
  schema_version: "understudy.executor-submit.v1";
  experiment_id: string;
  candidate: {
    candidate_id: string;
    executor: "modal" | "wafer" | "fireworks" | "spark" | "fixture";
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

export type ExperimentJobRef = {
  experimentId: string;
  candidateId: string;
  attempt: number;
  idempotencyKey: string;
  provider: "tinker";
  jobId: string;
  submittedAt: string;
  artifacts: ArtifactRef[];
};

export type ExecutorUsageReceipt = {
  job: ExperimentJobRef;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  promptTokens: number;
  completionTokens: number;
  trainingTokens?: number;
  wallClockSeconds?: number;
  costUsd?: number | null;
  artifact: ArtifactRef;
};

export type ExecutorCancellationReceipt = {
  job: ExperimentJobRef;
  cancelled: boolean;
  evidence_scope: "training" | "evaluation" | "all";
  artifact: ArtifactRef;
};

export type SubmitCandidateInput = {
  request: ExecutorSubmitRequest;
  experimentId: string;
  candidateId: string;
  attempt: number;
  jobId: string;
  submittedAt: string;
  artifacts?: ArtifactRef[];
};

export type ExecutorAdapter = {
  submit(
    request: ExecutorSubmitRequest,
    idempotencyKey: string,
  ): Promise<ExperimentJobRef>;
  inspect(job: ExperimentJobRef): Promise<ExperimentJobRef>;
  cancel(
    job: ExperimentJobRef,
    evidenceScope: "training" | "evaluation" | "all",
  ): Promise<ExecutorCancellationReceipt>;
  reconcileUsage(
    job: ExperimentJobRef,
    evidenceScope: "training" | "evaluation" | "all",
  ): Promise<ExecutorUsageReceipt>;
};

export type ExperimentExecutor = {
  submit(input: SubmitCandidateInput): Promise<ExperimentJobRef>;
  inspect(job: ExperimentJobRef): Promise<ExperimentJobRef>;
  cancel(
    job: ExperimentJobRef,
    evidenceScope: "training" | "evaluation" | "all",
  ): Promise<ExecutorCancellationReceipt>;
  reconcileUsage(
    job: ExperimentJobRef,
    evidenceScope: "training" | "evaluation" | "all",
  ): Promise<ExecutorUsageReceipt>;
};

export function createExperimentExecutor(
  adapter: ExecutorAdapter,
): ExperimentExecutor {
  return {
    submit: async (input) =>
      adapter.submit(
        buildExecutorSubmitRequest(input.request),
        experimentIdempotencyKey(input),
      ),
    inspect: (job) => adapter.inspect(job),
    cancel: (job, evidenceScope) => adapter.cancel(job, evidenceScope),
    reconcileUsage: (job, evidenceScope) =>
      adapter.reconcileUsage(job, evidenceScope),
  };
}

export function experimentIdempotencyKey(input: {
  experimentId: string;
  candidateId: string;
  attempt: number;
}): string {
  return createHash("sha256")
    .update(
      `${input.experimentId}\0${input.candidateId}\0${String(input.attempt)}`,
      "utf8",
    )
    .digest("hex");
}

export function submitCandidateJob(
  input: SubmitCandidateInput,
): ExperimentJobRef {
  if (
    input.request.experiment_id !== input.experimentId ||
    input.request.candidate.candidate_id !== input.candidateId ||
    input.request.attempt !== input.attempt
  ) {
    throw new Error("submit identity does not match idempotency tuple");
  }
  return {
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    attempt: input.attempt,
    idempotencyKey: experimentIdempotencyKey(input),
    provider: "tinker",
    jobId: input.jobId,
    submittedAt: input.submittedAt,
    artifacts: input.artifacts ?? [],
  };
}

export function buildExecutorSubmitRequest(
  request: ExecutorSubmitRequest,
): ExecutorSubmitRequest {
  return structuredClone(request);
}
