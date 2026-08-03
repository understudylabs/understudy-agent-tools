import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SCHEMA = "understudy.serving_parity.v1" as const;
export const PROMOTION_RECEIPT = "understudy.promotion_receipt.v1" as const;
export type Lane = "tinker" | "vllm" | "fireworks";
export type Sampling = { temperature: number; top_p: number | null; max_tokens: number | null; seed: number | null };
export type EvalRow = { schema_version: "understudy.eval_result.v1"; task_id: string; score: number };
export type LaneInput = {
  lane: Lane; artifact_ref: string; artifact_sha256: string; contract_fingerprint: string;
  rendered_prompt_fingerprint: string; protocol_id: string; sampling: Sampling;
  stop_sequences: string[]; rows: EvalRow[]; parse_ok: boolean; deviations?: string[];
};
export type EvidenceStatus = "observed" | "weak" | "deviation" | "failed";
export type Preflight = { schema_version: "understudy.serving_contract.v1"; passed: boolean; evidence_status: EvidenceStatus; diagnostics: string[]; lanes: Record<string, { rendered_prompt_fingerprint: string; artifact_ref: string; artifact_sha256: string; evidence_status: EvidenceStatus }> };
export type ParityArtifact = {
  schema_version: typeof SCHEMA; promotion_receipt_schema: typeof PROMOTION_RECEIPT; passed: boolean;
  evidence_status: EvidenceStatus; preflight: Preflight; minimum_paired_sample: number; paired_sample: number;
  lane_pairs: Record<string, { paired_sample: number; mean_delta: number; verdict: "PASS" | "FAIL" }>;
  refs: Array<{ ref: string; sha256: string }>; caveats: string[];
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());
const fail = (message: string): never => { throw new Error(`serving parity refused: ${message}`); };
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

export function observedRenderFingerprint(renderedPrompt: string): string { return sha256(renderedPrompt); }
export function artifactSha256(bytes: string | Buffer): string { return sha256(bytes.toString()); }

export function preflightServingParity(lanes: LaneInput[], options: { minimumPairedSample?: number } = {}): Preflight {
  const min = options.minimumPairedSample ?? 20;
  if (!Number.isInteger(min) || min < 2) fail("minimum paired sample must be an integer >= 2");
  const diagnostics: string[] = [];
  const output: Preflight["lanes"] = {};
  const reference = lanes[0];
  if (!reference || lanes.length < 2) diagnostics.push("at least two lanes are required");
  if (new Set(lanes.map((lane) => lane.lane)).size !== lanes.length) diagnostics.push("lane names must be unique");
  for (const lane of lanes) {
    if (!lane.artifact_ref || !validHash(lane.artifact_sha256)) diagnostics.push(`${lane.lane}: artifact ref and valid sha256 are required`);
    if (!validHash(lane.rendered_prompt_fingerprint)) diagnostics.push(`${lane.lane}: observed render fingerprint is required`);
    if (!validHash(lane.contract_fingerprint)) diagnostics.push(`${lane.lane}: contract fingerprint is required`);
    if (!lane.parse_ok) diagnostics.push(`${lane.lane}: parse evidence failed`);
    if (reference && lane.rendered_prompt_fingerprint !== reference.rendered_prompt_fingerprint) diagnostics.push(`${lane.lane}: render fingerprint deviation`);
    if (reference && lane.contract_fingerprint !== reference.contract_fingerprint) diagnostics.push(`${lane.lane}: contract fingerprint deviation`);
    if (reference && lane.protocol_id !== reference.protocol_id) diagnostics.push(`${lane.lane}: protocol deviation`);
    if (reference && canonical(lane.sampling) !== canonical(reference.sampling)) diagnostics.push(`${lane.lane}: sampling deviation`);
    if (reference && canonical(lane.stop_sequences) !== canonical(reference.stop_sequences)) diagnostics.push(`${lane.lane}: stop sequence deviation`);
    if (new Set(lane.rows.map((row) => row.task_id)).size !== lane.rows.length) diagnostics.push(`${lane.lane}: duplicate task ids`);
    output[lane.lane] = { rendered_prompt_fingerprint: lane.rendered_prompt_fingerprint, artifact_ref: lane.artifact_ref, artifact_sha256: lane.artifact_sha256, evidence_status: lane.deviations?.length ? "deviation" : "observed" };
  }
  const weak = lanes.some((lane) => (lane.deviations?.length ?? 0) > 0);
  if (reference) for (const lane of lanes.slice(1)) {
    const ids = new Set(lane.rows.map((row) => row.task_id));
    const paired = reference.rows.filter((row) => ids.has(row.task_id)).length;
    if (paired < min) diagnostics.push(`${lane.lane}: paired sample ${paired} is below minimum ${min}`);
  }
  const status: EvidenceStatus = diagnostics.length ? (weak ? "deviation" : "failed") : "observed";
  return { schema_version: "understudy.serving_contract.v1", passed: diagnostics.length === 0, evidence_status: status, diagnostics, lanes: output };
}

export function scoreServingParity(lanes: LaneInput[], options: { minimumPairedSample?: number; equivalenceBand?: number } = {}): ParityArtifact {
  const minimum = options.minimumPairedSample ?? 20;
  const band = options.equivalenceBand ?? 0.05;
  if (!Number.isFinite(band) || band < 0 || band > 1) fail("equivalence band must be in [0, 1]");
  const preflight = preflightServingParity(lanes, { minimumPairedSample: minimum });
  if (!preflight.passed) fail(preflight.diagnostics.join("; "));
  const reference = lanes[0];
  const pairs: ParityArtifact["lane_pairs"] = {};
  let paired = Number.POSITIVE_INFINITY;
  for (const lane of lanes.slice(1)) {
    const base = new Map(reference.rows.map((row) => [row.task_id, row.score]));
    const other = new Map(lane.rows.map((row) => [row.task_id, row.score]));
    const deltas = [...base].filter(([id]) => other.has(id)).map(([id, score]) => (other.get(id)! - score));
    paired = Math.min(paired, deltas.length);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    pairs[lane.lane] = { paired_sample: deltas.length, mean_delta: mean, verdict: deltas.length >= minimum && Math.abs(mean) <= band ? "PASS" : "FAIL" };
  }
  const refs = lanes.map((lane) => ({ ref: lane.artifact_ref, sha256: lane.artifact_sha256 }));
  return { schema_version: SCHEMA, promotion_receipt_schema: PROMOTION_RECEIPT, passed: Object.values(pairs).every((p) => p.verdict === "PASS"), evidence_status: preflight.evidence_status, preflight, minimum_paired_sample: minimum, paired_sample: paired, lane_pairs: pairs, refs, caveats: preflight.diagnostics };
}

export function readLane(path: string, lane: Lane, metadata: Omit<LaneInput, "lane" | "rows">): LaneInput {
  const text = readFileSync(path, "utf8");
  const parsed = JSON.parse(text) as { rows?: EvalRow[] };
  return { lane, rows: parsed.rows ?? (Array.isArray(parsed) ? parsed as unknown as EvalRow[] : []), ...metadata };
}
