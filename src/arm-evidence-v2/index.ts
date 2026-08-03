import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "understudy.arm_evidence.v2" as const;
type Obj = Record<string, unknown>;
export type ArmEvidenceV2 = Obj & { schema_version: typeof SCHEMA_VERSION };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (value: unknown, path: string) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be lowercase SHA-256`);
};

export type GateInput = {
  source_binding: Obj;
  verifier_calibration: Obj;
  immutable_split_hashes: Obj;
  authorization: Obj;
  holdout_refusal: { no_hash: Obj; wrong_hash: Obj; exact_hash: Obj };
};

export function assertArmEntryEvidence(input: GateInput): ArmEvidenceV2 {
  for (const [name, value] of Object.entries(input)) if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const source = input.source_binding;
  const calibration = input.verifier_calibration;
  const splits = input.immutable_split_hashes;
  const auth = input.authorization;
  for (const [name, value] of Object.entries({ source_binding: source, verifier_calibration: calibration, immutable_split_hashes: splits, authorization: auth })) {
    if (typeof value.ref !== "string" || value.ref.length === 0) throw new Error(`${name}.ref is required`);
    sha(value.sha256, `${name}.sha256`);
  }
  if (calibration.verdict !== "pass") throw new Error("verifier calibration must pass");
  if (auth.approved !== true) throw new Error("authorization must be approved");
  if (auth.scope !== "pre_spend_arm") throw new Error("authorization scope must be pre_spend_arm");
  for (const [name, refusal] of Object.entries(input.holdout_refusal)) {
    if (!refusal || refusal.opened === true || refusal.result !== "refused") throw new Error(`holdout ${name} refusal is invalid`);
    if (typeof refusal.reason_ref !== "string" || !refusal.reason_ref) throw new Error(`holdout ${name} reason_ref is required`);
    sha(refusal.request_hash, `holdout_refusal.${name}.request_hash`);
  }
  return { schema_version: SCHEMA_VERSION, source_binding: source, verifier_calibration: calibration, immutable_split_hashes: splits, authorization: auth, holdout_refusal: input.holdout_refusal, evidence_hash: hash(input) };
}

export function assertNoSensitiveFields(value: unknown): void {
  const forbidden = /prompt|trace|secret|credential|token|weight/i;
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === "object") for (const [key, child] of Object.entries(v as Obj)) { if (forbidden.test(key)) throw new Error(`forbidden field at ${path}.${key}`); walk(child, `${path}.${key}`); }
  };
  walk(value, "$" );
}
