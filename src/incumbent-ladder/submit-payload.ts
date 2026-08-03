import { createHash } from "node:crypto";
import { ExperimentSubmitRequestSchema } from "../experiment-executor.js";

export const EXECUTOR_SUBMIT_SCHEMA_VERSION = "understudy.executor-submit.v1" as const;
export const EXECUTOR_SUBMIT_SCHEMA_ID =
  "https://understudylabs.com/schemas/understudy-train-v1/experiment-executor-submit-request.json";
export const EXECUTOR_ENUM = ["modal", "wafer", "fireworks", "spark", "fixture"] as const;
export type Executor = (typeof EXECUTOR_ENUM)[number];
// The canonical schema's executor enum does not currently include a Tinker lane.
// Callers must supply and validate the executor; this module deliberately does not guess one.

type JsonObject = Record<string, unknown>;
export type CandidateSubmitInput = Omit<JsonObject, "schema_version" | "idempotency_key"> & {
  experiment_id: string;
  candidate: {
    candidate_id: string;
    executor: string;
    model: string;
    model_revision?: string;
    policy_ref: string;
    policy_sha256: string;
  };
  attempt: number;
  workload: JsonObject;
  splits: JsonObject;
  limits: JsonObject;
};

function containsNamedMaterial(value: unknown, names: Set<string>, path = ""): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsNamedMaterial(value[index], names, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) return path ? `${path}.${key}` : key;
    const found = containsNamedMaterial(child, names, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return null;
}

function containsHoldout(value: unknown): string | null {
  return containsNamedMaterial(value, new Set(["holdout"]));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function idempotencyKey(input: Pick<CandidateSubmitInput, "experiment_id" | "candidate" | "attempt">): string {
  return createHash("sha256")
    .update(canonical({
      experiment_id: input.experiment_id,
      candidate_id: input.candidate.candidate_id,
      attempt: input.attempt,
    }))
    .digest("hex");
}

export function buildSubmitPayload(input: CandidateSubmitInput): JsonObject {
  const holdoutPath = containsHoldout(input);
  if (holdoutPath) throw new Error(`holdout-bearing submit input is rejected at ${holdoutPath}`);
  const rawPath = containsNamedMaterial(
    input,
    new Set(["prompt", "prompts", "label", "labels", "weight", "weights", "credential", "credentials", "trace", "traces", "raw"]),
  );
  if (rawPath) throw new Error(`raw material is rejected at ${rawPath}; submit artifact references and hashes only`);
  if (!EXECUTOR_ENUM.includes(input.candidate.executor as Executor)) {
    throw new Error(`unsupported executor ${input.candidate.executor}; choose a caller-validated executor`);
  }
  const payload = {
    schema_version: EXECUTOR_SUBMIT_SCHEMA_VERSION,
    ...input,
  };
  ExperimentSubmitRequestSchema.parse(payload);
  return payload;
}
