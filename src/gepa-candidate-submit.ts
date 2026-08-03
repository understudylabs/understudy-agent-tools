import { readFileSync, writeFileSync } from "node:fs";

import {
  ExperimentSubmitRequestSchema,
  type ExperimentSubmitRequest,
} from "./experiment-executor.js";

type JsonObject = Record<string, unknown>;

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
): ExperimentSubmitRequest {
  const config = (candidate.gepa_config ?? {}) as JsonObject;
  const model = options.model ?? (typeof config.model === "string" ? config.model : "");
  const fixture = candidate.fixture;
  const fixtureHash = candidate.fixture_sha256;
  const request: ExperimentSubmitRequest = {
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
      train_manifest_ref: `fixture://${fixture}/split/train/${candidate.train_split_sha256}`,
      train_manifest_sha256: candidate.train_split_sha256,
      dev_manifest_ref: `fixture://${fixture}/split/dev/${candidate.dev_split_sha256}`,
      dev_manifest_sha256: candidate.dev_split_sha256,
    },
    limits: {
      budget_usd: options.budgetUsd ?? 0,
      max_concurrent_candidates: Number(config.concurrency ?? 1),
      max_concurrent_requests_per_candidate: Number(config.concurrency ?? 1),
      max_rollouts: Number(config.max_rollouts ?? 1),
      max_runtime_seconds: options.maxRuntimeSeconds ?? 604800,
    },
  };
  return ExperimentSubmitRequestSchema.parse(request);
}

export function readFrozenCandidate(path: string): FrozenCandidate {
  const candidate = JSON.parse(readFileSync(path, "utf8")) as FrozenCandidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate artifact must be an object");
  }
  return candidate;
}

export function emitCandidateSubmitRequest(
  candidatePath: string,
  outputPath: string,
  options: Parameters<typeof buildCandidateSubmitRequest>[1] = {},
): ExperimentSubmitRequest {
  const request = buildCandidateSubmitRequest(readFrozenCandidate(candidatePath), options);
  writeFileSync(outputPath, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}
