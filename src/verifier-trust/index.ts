import { createHash } from "node:crypto";

export const VERIFIER_TRUST_VERSION = "understudy.verifier_trust.v1" as const;
export type ArmEvidence = { probes: number; false_positive_rate: number | null; false_negative_rate: number | null; mcc: number | null; reward_hacked_probes: number; replay_fidelity_mismatches?: number };
export type TrustBinding = { source_binding_sha256: string; verifier_sha256: string; fixture_sha256: string };
export type TrustReceipt = TrustBinding & { schema_version: typeof VERIFIER_TRUST_VERSION; gate_version: "verifier-reliability-gate-v1"; natural: ArmEvidence; adversarial: ArmEvidence; verdict: "trusted" | "untrusted" | "insufficient-evidence"; reasons: string[]; idempotency_key: string };

export const TRUST_GATE = Object.freeze({ min_probes: 24, min_natural_probes: 8, max_false_positive_rate: 0, max_false_negative_rate: 0.05, min_mcc: 0.9, max_reward_hacked_probes: 0 });

function canonical(value: unknown): string { return JSON.stringify(value, (_k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v); }
export function trustIdempotencyKey(binding: TrustBinding, natural: ArmEvidence, adversarial: ArmEvidence): string {
  return createHash("sha256").update(canonical({ binding, gate: TRUST_GATE, natural, adversarial })).digest("hex");
}
function passes(e: ArmEvidence, min: number): boolean {
  return e.probes >= min && e.false_positive_rate === 0 && e.false_negative_rate !== null && e.false_negative_rate <= TRUST_GATE.max_false_negative_rate && e.mcc !== null && e.mcc >= TRUST_GATE.min_mcc && e.reward_hacked_probes === 0 && (e.replay_fidelity_mismatches ?? 0) === 0;
}
export function evaluateTrustGate(binding: TrustBinding, natural: ArmEvidence, adversarial: ArmEvidence): TrustReceipt {
  const reasons: string[] = [];
  if (!passes(adversarial, TRUST_GATE.min_probes)) reasons.push("adversarial_arm_failed");
  if (!passes(natural, TRUST_GATE.min_natural_probes)) reasons.push("natural_arm_failed_or_insufficient");
  if (!binding.source_binding_sha256 || !binding.verifier_sha256 || !binding.fixture_sha256) reasons.push("missing_provenance_binding");
  return { schema_version: VERIFIER_TRUST_VERSION, gate_version: "verifier-reliability-gate-v1", ...binding, natural, adversarial, verdict: reasons.length === 0 ? "trusted" : (natural.probes < TRUST_GATE.min_natural_probes ? "insufficient-evidence" : "untrusted"), reasons, idempotency_key: trustIdempotencyKey(binding, natural, adversarial) };
}
