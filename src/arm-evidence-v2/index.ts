import { createHash } from "node:crypto";

export const SCHEMA_VERSION = "understudy.arm_evidence.v2" as const;
type Obj = Record<string, unknown>;
export type ArmEvidenceV2 = Obj & { schema_version: typeof SCHEMA_VERSION };

const canonical = (value: unknown): string => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
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

const exactKeys = (value: Obj, expected: string[], path: string) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${path} must contain only ${wanted.join(", ")}`);
};

export function assertArmEntryEvidence(input: GateInput): ArmEvidenceV2 {
  assertNoSensitiveFields(input);
  exactKeys(input as unknown as Obj, ["source_binding", "verifier_calibration", "immutable_split_hashes", "authorization", "holdout_refusal"], "input");
  for (const [name, value] of Object.entries(input)) if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const source = input.source_binding;
  const calibration = input.verifier_calibration;
  const splits = input.immutable_split_hashes;
  const auth = input.authorization;
  exactKeys(source, ["ref", "sha256"], "source_binding");
  exactKeys(calibration, ["ref", "sha256", "verdict"], "verifier_calibration");
  exactKeys(splits, ["ref", "sha256", "train_sha256", "dev_sha256", "holdout_sha256"], "immutable_split_hashes");
  exactKeys(auth, ["ref", "sha256", "approved", "scope"], "authorization");
  exactKeys(input.holdout_refusal, ["no_hash", "wrong_hash", "exact_hash"], "holdout_refusal");
  for (const [name, value] of Object.entries({ source_binding: source, verifier_calibration: calibration, immutable_split_hashes: splits, authorization: auth })) {
    if (typeof value.ref !== "string" || value.ref.length === 0) throw new Error(`${name}.ref is required`);
    sha(value.sha256, `${name}.sha256`);
  }
  if (calibration.verdict !== "pass") throw new Error("verifier calibration must pass");
  if (auth.approved !== true) throw new Error("authorization must be approved");
  if (auth.scope !== "pre_spend_arm") throw new Error("authorization scope must be pre_spend_arm");
  for (const key of ["train_sha256", "dev_sha256", "holdout_sha256"]) sha(splits[key], `immutable_split_hashes.${key}`);
  for (const [name, refusal] of Object.entries(input.holdout_refusal)) {
    exactKeys(refusal, ["receipt_ref", "receipt_sha256", "signature_ref", "reason_ref", "request_hash", "result", "opened"], `holdout_refusal.${name}`);
    if (!refusal || refusal.opened === true || refusal.result !== "refused") throw new Error(`holdout ${name} refusal is invalid`);
    for (const key of ["receipt_ref", "signature_ref", "reason_ref"]) if (typeof refusal[key] !== "string" || !refusal[key]) throw new Error(`holdout ${name} ${key} is required`);
    sha(refusal.receipt_sha256, `holdout_refusal.${name}.receipt_sha256`);
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
