/**
 * Workflow-facing verifier contract.
 *
 * This step is pure: the Workflow supplies the registry value or an artifact
 * reference with an already-loaded value. Disk loading remains a CLI concern.
 * No provider calls, polling, controller state, or raw workload content cross
 * this boundary.
 */
import {
  AdapterPortfolioRegistrySchema,
  AdapterPromotionStepDecisionSchema,
  type AdapterPortfolioRegistry,
  type AdapterPromotionStepDecision,
  type ArtifactRef,
  type PromotionPolicy,
} from "./types.js";
import { registrySha256, refSha256 } from "./contract.js";
import { evaluatePromotion } from "./gate.js";

export type RegistryStepInput =
  | AdapterPortfolioRegistry
  | (ArtifactRef & { value: AdapterPortfolioRegistry });

export interface AdapterPortfolioStepInput {
  experiment_id: string;
  candidate_id: string;
  attempt: number;
  evaluated_at: string;
  registry: RegistryStepInput;
  policy?: PromotionPolicy;
}

export interface AdapterPortfolioWorkflowEvent {
  schema_version: "understudy.adapter_portfolio_event.v1";
  sequence: number;
  run_id: string;
  stream: "run" | "candidate" | "score" | "error";
  type: "promotion_check" | "promotion_decision";
  occurred_at: string;
  phase: "evaluation" | "terminal";
  message: "Adapter portfolio gate check." | "Adapter portfolio decision.";
  details: Record<string, string | number | boolean>;
}

function registryValue(input: RegistryStepInput): {
  registry: AdapterPortfolioRegistry;
  ref: ArtifactRef;
} {
  if ("value" in input) {
    const registry = AdapterPortfolioRegistrySchema.parse(input.value);
    const actualSha = registrySha256(registry);
    if (actualSha !== input.sha256) {
      throw new Error("Registry artifact hash does not match its supplied value.");
    }
    return { registry, ref: { uri: input.uri, sha256: input.sha256 } };
  }
  const registry = AdapterPortfolioRegistrySchema.parse(input);
  return {
    registry,
    ref: { uri: "inline:adapter-portfolio-registry", sha256: registrySha256(registry) },
  };
}

function consumedEvidenceIds(
  registry: AdapterPortfolioRegistry,
  candidateName: string,
): string[] {
  const candidate = registry.adapters[candidateName];
  if (!candidate) return [];
  const suites = new Set([candidate.suite]);
  for (const adapter of Object.values(registry.adapters)) {
    if (adapter.status === "promoted") suites.add(adapter.suite);
  }
  const ids = new Set<string>();
  for (const adapter of Object.values(registry.adapters)) {
    for (const row of adapter.evidence) {
      const candidateEvidence =
        adapter.name === candidateName &&
        row.subject === "adapter" &&
        row.adapter_name === candidateName &&
        row.suite === candidate.suite;
      const baseEvidence =
        row.subject === "base" &&
        (row.split === "dev" || row.split === "holdout") &&
        suites.has(row.suite);
      const promotedEvidence =
        row.subject === "adapter" &&
        row.split === "holdout" &&
        Object.values(registry.adapters).some(
          (prior) => prior.status === "promoted" && prior.name === row.adapter_name && prior.suite === row.suite,
        );
      if (candidateEvidence || baseEvidence || promotedEvidence) ids.add(row.evidence_id);
    }
  }
  return [...ids].sort();
}

export function evaluateAdapterPortfolioStep(
  input: AdapterPortfolioStepInput,
): AdapterPromotionStepDecision {
  const { registry, ref } = registryValue(input.registry);
  const idempotency_key = refSha256(`${input.experiment_id}\n${input.candidate_id}\n${input.attempt}`);
  const decision = evaluatePromotion(
    registry,
    input.candidate_id,
    input.policy,
    input.evaluated_at,
  );
  const candidate = registry.adapters[input.candidate_id];
  const output = {
    ...decision,
    idempotency_key,
    inputs: {
      registry: ref,
      candidate_holdout: candidate?.holdout
        ? { uri: candidate.holdout.path, sha256: candidate.holdout.sha256, row_count: candidate.holdout.row_count }
        : null,
      evidence_ids: consumedEvidenceIds(registry, input.candidate_id),
    },
  };
  return AdapterPromotionStepDecisionSchema.parse(output);
}

export function promotionEvents(
  input: AdapterPortfolioStepInput,
  decision: AdapterPromotionStepDecision,
): AdapterPortfolioWorkflowEvent[] {
  return [
    ...decision.checks.map((item, sequence) => ({
      schema_version: "understudy.adapter_portfolio_event.v1" as const,
      sequence,
      run_id: input.experiment_id,
      stream: item.check === "status"
        ? "candidate" as const
        : item.status === "pass" ? "score" as const : "error" as const,
      type: "promotion_check" as const,
      occurred_at: input.evaluated_at,
      phase: "evaluation" as const,
      message: "Adapter portfolio gate check." as const,
      details: {
        candidate_id: input.candidate_id,
        attempt: input.attempt,
        check: item.check,
        status: item.status,
        idempotency_key: decision.idempotency_key,
        registry_sha256: decision.inputs.registry.sha256,
      },
    })),
    {
      schema_version: "understudy.adapter_portfolio_event.v1",
      sequence: decision.checks.length,
      run_id: input.experiment_id,
      stream: "run",
      type: "promotion_decision",
      occurred_at: input.evaluated_at,
      phase: "terminal",
      message: "Adapter portfolio decision.",
      details: {
        candidate_id: input.candidate_id,
        attempt: input.attempt,
        decision: decision.decision,
        idempotency_key: decision.idempotency_key,
        registry_sha256: decision.inputs.registry.sha256,
      },
    },
  ];
}
