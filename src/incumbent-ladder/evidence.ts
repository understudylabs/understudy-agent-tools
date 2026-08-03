import { buildSaturationCertificate, type SaturationCertificate } from "./saturation.js";
import { PARSER_REVISION, PARSER_REVISION_SHA256, type Aggregate } from "./tool-call-verifier.js";

export const LADDER_EVIDENCE_SCHEMA_VERSION = "understudy.ladder_evidence.v1" as const;

export type EvidenceRowInput = {
  experiment_id: string;
  workload: { id: string; description: string; fixture_sha256: string };
  incumbent: { provider: string; model: string; serving_contract: string; latency_ms?: number; cost_usd?: number };
  candidates: Array<{
    arm_id: string;
    base_model: string;
    renderer: string;
    rung: string;
    lora_rank?: number | null;
    steps?: number | null;
    seed?: number | null;
    split_refs: { train: string; dev: string; holdout: string };
    split_hashes: { train: string; dev: string; holdout: string };
    by_band: Record<string, Aggregate>;
    aggregate: Aggregate;
    budget_usd?: number | null;
    actual_usd?: number | null;
    estimated_usd?: number | null;
    unpriced?: boolean;
    artifact_refs: string[];
    failure_clusters?: string[];
  }>;
  holdout: { status: "clean" | "executed"; sha256: string };
  saturation: SaturationCertificate;
  evidence_scope: "dev-only" | "holdout";
  claim_boundary: string;
  created_at?: string;
};

export function buildEvidenceRow(input: EvidenceRowInput) {
  if (input.holdout.status !== "clean") throw new Error("ladder evidence requires a clean holdout");
  if (!/^[a-f0-9]{64}$/.test(input.workload.fixture_sha256)) throw new Error("invalid fixture hash");
  return {
    schema_version: LADDER_EVIDENCE_SCHEMA_VERSION,
    ...input,
    parser: { revision: PARSER_REVISION, sha256: PARSER_REVISION_SHA256 },
    created_at: input.created_at ?? new Date().toISOString(),
  };
}

export function buildPromotionDecision(input: {
  workload_id: string;
  evidence_ref: string;
  evidence_sha256: string;
  incumbent_model: string;
  candidate_model: string;
  candidate_score: number;
  incumbent_score: number;
  claim_boundary: string;
}) {
  const decision = input.candidate_score >= input.incumbent_score ? "evaluate-first" : "local-only";
  return {
    schema_version: "understudy.route_decision_packet.v1",
    decision,
    workload_id: input.workload_id,
    incumbent: { model: input.incumbent_model },
    model_id: input.candidate_model,
    evidence: { packet_path: input.evidence_ref, eval_results_sha256: input.evidence_sha256 },
    constraints: { holdout: "clean", claim_boundary: input.claim_boundary },
    recommended_next_command: "Run the deliberate holdout gate only after candidate freeze.",
    approval_required_before: ["holdout execution", "production promotion"],
  };
}

export { buildSaturationCertificate };
