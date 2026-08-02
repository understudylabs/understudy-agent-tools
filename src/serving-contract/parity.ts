import { readFileSync } from "node:fs";

import { z } from "zod";

import { bootstrapCI } from "../bootstrap-ci.js";
import type { EvalRow } from "../benchmark-hub-types.js";
import {
  ArtifactRefSchema,
  EVAL_RESULT_SCHEMA,
  SamplingSchema,
  SERVING_CONTRACT_SCHEMA,
  SERVING_PARITY_SCHEMA,
  ServingLaneSchema,
  ToolProtocolSchema,
  requireServingContract,
  type ArtifactRef,
  type Sampling,
  type ServingContract,
  type ServingLane,
} from "./contract.js";
import { canonicalJson, contractFingerprint, contractSha256, renderedPromptFingerprint, sha256 } from "./fingerprint.js";
import { parseAssistantMessage } from "./parse.js";

const EvalRowInputSchema = z.object({
  schema_version: z.literal(EVAL_RESULT_SCHEMA),
  task_id: z.string().min(1),
  score: z.number().finite(),
}).passthrough();

export type PreflightLaneInput = {
  lane: ServingLane;
  contract_fingerprint?: string;
  observed_prompt?: string;
  rendered_prompt_fingerprint?: string;
  protocol_id?: ServingContract["tool_protocol"]["id"];
  sampling?: Sampling;
  stop_sequences?: string[];
  rows?: Array<Record<string, unknown> | EvalRow>;
  probes?: unknown[];
  acknowledged_deviations?: string[];
  artifact_ref?: ArtifactRef;
};

export type ServingLaneArtifact = Omit<PreflightLaneInput, "lane"> & { lane?: ServingLane; rows: EvalRow[] };

export type PreflightDiagnostic = {
  lane: ServingLane;
  cause: "contract fingerprint mismatch" | "render unobserved" | "renderer mismatch"
    | "tool-protocol mismatch" | "sampling mismatch" | "parse failure" | "no parse evidence";
  detail: string;
};

export type PreflightResult = {
  schema_version: typeof SERVING_CONTRACT_SCHEMA;
  base_id: string;
  passed: boolean;
  contract_fingerprint: string;
  contract_sha256: string;
  lanes: Record<string, {
    artifact_ref: ArtifactRef;
    contract_fingerprint?: string;
    rendered_prompt_fingerprint?: string;
    sampling?: Sampling;
    stop_sequences?: string[];
    parse_failure_rate: number;
    rows_checked: number;
    caveats: string[];
  }>;
  diagnostics: PreflightDiagnostic[];
  caveats: string[];
};

function parseFailureRate(input: PreflightLaneInput, protocol: ServingContract["tool_protocol"]["id"]): {
  rate: number;
  checked: number;
} {
  const values = [...(input.rows ?? []), ...(input.probes ?? [])];
  let failures = 0;
  let checked = 0;
  for (const value of values) {
    const row = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof row.parse_ok === "boolean") {
      checked += 1;
      if (!row.parse_ok) failures += 1;
      continue;
    }
    const raw = row.raw_response ?? row.response ?? row.assistant;
    if (raw === undefined) continue;
    checked += 1;
    if (parseAssistantMessage(protocol, raw).malformed) failures += 1;
  }
  return { rate: checked === 0 ? 0 : failures / checked, checked };
}

function acknowledged(input: PreflightLaneInput, field: string): boolean {
  return input.acknowledged_deviations?.includes(field) ?? false;
}

function inputArtifactRef(input: PreflightLaneInput): ArtifactRef {
  if (input.artifact_ref) return ArtifactRefSchema.parse(input.artifact_ref);
  return {
    ref: `memory://${input.lane}`,
    sha256: sha256(canonicalJson(input)),
  };
}

export function preflightServingContract(
  baseId: string,
  inputs: PreflightLaneInput[],
  options: { parseFailureThreshold?: number; allowUnobservedRender?: boolean } = {},
): PreflightResult {
  const contract = requireServingContract(baseId);
  const expectedContractFingerprint = contractFingerprint(contract);
  const diagnostics: PreflightDiagnostic[] = [];
  const lanes: PreflightResult["lanes"] = {};
  const caveats: string[] = [];
  const threshold = options.parseFailureThreshold ?? 0;
  let referenceRenderedFingerprint: string | undefined;
  let referenceStopSequences: string[] | undefined;

  for (const input of inputs) {
    const parsed = parseFailureRate(input, input.protocol_id ?? contract.tool_protocol.id);
    const laneCaveats: string[] = [];
    if (input.contract_fingerprint !== expectedContractFingerprint) {
      diagnostics.push({
        lane: input.lane,
        cause: "contract fingerprint mismatch",
        detail: input.contract_fingerprint
          ? `observed ${input.contract_fingerprint} differs from ${expectedContractFingerprint}`
          : "lane did not supply the contract fingerprint",
      });
    }
    if (input.observed_prompt === undefined && input.rendered_prompt_fingerprint === undefined) {
      const detail = "lane supplied no observed rendered prompt or rendered-prompt fingerprint";
      if (options.allowUnobservedRender) {
        laneCaveats.push("render unobserved");
        caveats.push(`${input.lane}: render unobserved`);
      } else {
        diagnostics.push({ lane: input.lane, cause: "render unobserved", detail });
      }
    }
    const renderedFingerprint = input.observed_prompt === undefined
      ? input.rendered_prompt_fingerprint
      : renderedPromptFingerprint(input.observed_prompt);
    if (renderedFingerprint !== undefined && referenceRenderedFingerprint === undefined) {
      referenceRenderedFingerprint = renderedFingerprint;
    } else if (renderedFingerprint !== undefined && renderedFingerprint !== referenceRenderedFingerprint
      && !acknowledged(input, "renderer")) {
      diagnostics.push({
        lane: input.lane,
        cause: "renderer mismatch",
        detail: "rendered-prompt fingerprint differs from the reference lane",
      });
    } else if (renderedFingerprint !== undefined && renderedFingerprint !== referenceRenderedFingerprint) {
      laneCaveats.push("acknowledged renderer deviation");
    }
    if (input.protocol_id !== contract.tool_protocol.id && !acknowledged(input, "tool_protocol")) {
      diagnostics.push({
        lane: input.lane,
        cause: "tool-protocol mismatch",
        detail: `observed ${input.protocol_id ?? "missing"} differs from canonical ${contract.tool_protocol.id}`,
      });
    } else if (input.protocol_id !== contract.tool_protocol.id) {
      laneCaveats.push("acknowledged tool-protocol deviation");
    }
    if (canonicalJson(input.sampling) !== canonicalJson(contract.sampling) && !acknowledged(input, "sampling")) {
      diagnostics.push({
        lane: input.lane,
        cause: "sampling mismatch",
        detail: `observed sampling differs from canonical ${canonicalJson(contract.sampling)}`,
      });
    } else if (canonicalJson(input.sampling) !== canonicalJson(contract.sampling)) {
      laneCaveats.push("acknowledged sampling deviation");
    }
    if (input.stop_sequences === undefined) {
      diagnostics.push({
        lane: input.lane,
        cause: "renderer mismatch",
        detail: "lane did not supply observed stop sequences",
      });
    } else if (contract.renderer.stop_sequences_pinned
      && canonicalJson(input.stop_sequences) !== canonicalJson(contract.renderer.stop_sequences)
      && !acknowledged(input, "stop_sequences")) {
      diagnostics.push({
        lane: input.lane,
        cause: "renderer mismatch",
        detail: "observed stop sequences differ from canonical contract",
      });
    } else if (!contract.renderer.stop_sequences_pinned && referenceStopSequences === undefined) {
      referenceStopSequences = input.stop_sequences;
    } else if (!contract.renderer.stop_sequences_pinned
      && canonicalJson(input.stop_sequences) !== canonicalJson(referenceStopSequences)
      && !acknowledged(input, "stop_sequences")) {
      diagnostics.push({
        lane: input.lane,
        cause: "renderer mismatch",
        detail: "observed unpinned stop sequences differ from the reference lane",
      });
    }
    if (parsed.checked === 0) {
      diagnostics.push({ lane: input.lane, cause: "no parse evidence", detail: "no parseable rows or probe replies were supplied" });
    } else if (parsed.rate > threshold) {
      diagnostics.push({
        lane: input.lane,
        cause: "parse failure",
        detail: `${parsed.rate} parse-failure rate exceeds ${threshold}`,
      });
    }
    lanes[input.lane] = {
      artifact_ref: inputArtifactRef(input),
      contract_fingerprint: input.contract_fingerprint,
      rendered_prompt_fingerprint: renderedFingerprint,
      sampling: input.sampling,
      stop_sequences: input.stop_sequences,
      parse_failure_rate: parsed.rate,
      rows_checked: parsed.checked,
      caveats: laneCaveats,
    };
  }
  return {
    schema_version: SERVING_CONTRACT_SCHEMA,
    base_id: baseId,
    contract_sha256: contractSha256(contract),
    passed: inputs.length >= 2 && diagnostics.length === 0,
    contract_fingerprint: expectedContractFingerprint,
    lanes,
    diagnostics,
    caveats,
  };
}

export type LanePairResult = {
  task_ids: { missing: string[]; extra: string[] };
  paired_deltas: Array<{ task_id: string; delta: number }>;
  ci95: ReturnType<typeof bootstrapCI>;
  verdict: "PASS" | "FAIL";
};

export type ServingParityArtifact = {
  schema_version: typeof SERVING_PARITY_SCHEMA;
  base_id: string;
  contract_sha256: string;
  preflight: PreflightResult;
  lanes: Record<string, { artifact_ref: ArtifactRef; task_count: number; macro_average: number }>;
  lane_pairs: Record<string, LanePairResult>;
  verdict: "PASS" | "FAIL";
  equivalence_band: { lo: number; hi: number };
  caveats: string[];
  provenance: { row_schema: typeof EVAL_RESULT_SCHEMA; seed: string };
};

function scoreMap(rows: EvalRow[]): Map<string, number> {
  const result = new Map<string, number>();
  rows.forEach((row, index) => {
    const parsed = EvalRowInputSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`invalid eval row at index ${index}: expected ${EVAL_RESULT_SCHEMA}, task_id, and numeric score`);
    }
    if (result.has(row.task_id)) throw new Error(`duplicate eval row task_id: ${row.task_id}`);
    result.set(row.task_id, row.score as number);
  });
  return result;
}

export function scoreServingParity(
  baseId: string,
  preflight: PreflightResult,
  laneRows: Record<string, EvalRow[]>,
  options: { referenceLane?: ServingLane; equivalenceBand?: number; seed?: string } = {},
): ServingParityArtifact {
  if (!preflight.passed) throw new Error("serving parity refused: contract preflight did not pass");
  requireServingContract(baseId);
  const laneNames = Object.keys(laneRows);
  if (laneNames.length < 2) throw new Error("serving parity refused: at least two lanes are required");
  const referenceLane = options.referenceLane ?? laneNames[0] as ServingLane;
  const referenceRows = laneRows[referenceLane];
  if (!referenceRows) throw new Error(`serving parity refused: reference lane '${referenceLane}' has no rows`);
  const reference = scoreMap(referenceRows);
  const lanes: ServingParityArtifact["lanes"] = {};
  const lanePairs: ServingParityArtifact["lane_pairs"] = {};
  const band = options.equivalenceBand ?? 0.05;
  const seed = options.seed ?? `${baseId}::serving-parity`;

  for (const lane of laneNames) {
    const scores = scoreMap(laneRows[lane]);
    const values = [...scores.values()];
    lanes[lane] = {
      artifact_ref: preflight.lanes[lane]?.artifact_ref ?? {
        ref: `memory://${lane}`,
        sha256: sha256(canonicalJson(laneRows[lane])),
      },
      task_count: values.length,
      macro_average: values.length === 0 ? 0 : values.reduce((sum, score) => sum + score, 0) / values.length,
    };
    if (lane === referenceLane) continue;
    const missing = [...reference.keys()].filter((taskId) => !scores.has(taskId)).sort();
    const extra = [...scores.keys()].filter((taskId) => !reference.has(taskId)).sort();
    const pairedDeltas = [...reference.entries()]
      .filter(([taskId]) => scores.has(taskId))
      .map(([taskId, baseline]) => ({ task_id: taskId, delta: (scores.get(taskId) as number) - baseline }));
    const ci95 = missing.length > 0 || extra.length > 0
      ? null
      : bootstrapCI(pairedDeltas.map((entry) => entry.delta), { seed: `${seed}::${lane}` });
    const passed = missing.length === 0 && extra.length === 0 && ci95 !== null
      && ci95.lo >= -band && ci95.hi <= band && ci95.lo <= 0 && ci95.hi >= 0;
    lanePairs[lane] = {
      task_ids: { missing, extra },
      paired_deltas: pairedDeltas,
      ci95,
      verdict: passed ? "PASS" : "FAIL",
    };
  }
  const pairValues = Object.values(lanePairs);
  return {
    schema_version: SERVING_PARITY_SCHEMA,
    base_id: baseId,
    contract_sha256: contractSha256(requireServingContract(baseId)),
    preflight,
    lanes,
    lane_pairs: lanePairs,
    verdict: pairValues.length >= 1 && pairValues.every((pair) => pair.verdict === "PASS") ? "PASS" : "FAIL",
    equivalence_band: { lo: -band, hi: band },
    caveats: preflight.caveats,
    provenance: { row_schema: EVAL_RESULT_SCHEMA, seed },
  };
}

export function readJsonRows(path: string): EvalRow[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = path.endsWith(".jsonl")
      ? text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid eval rows in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).rows)
      ? (parsed as Record<string, unknown>).rows as unknown[]
      : [parsed];
  return candidates.map((row, index) => {
    const result = EvalRowInputSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`invalid eval row ${path}:${index + 1}: expected ${EVAL_RESULT_SCHEMA}, task_id, and numeric score`);
    }
    return result.data as EvalRow;
  });
}

export function readServingLaneArtifact(path: string): ServingLaneArtifact {
  const bytes = readFileSync(path);
  const artifact_ref: ArtifactRef = { ref: path, sha256: sha256(bytes) };
  const text = bytes.toString("utf8").trim();
  if (!text) return { rows: [], artifact_ref };
  if (path.endsWith(".jsonl")) return { rows: readJsonRows(path), artifact_ref };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid serving lane artifact in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rows: readJsonRows(path), artifact_ref };
  }
  const object = parsed as Record<string, unknown>;
  if (object.lane !== undefined && !ServingLaneSchema.safeParse(object.lane).success) {
    throw new Error(`invalid serving lane artifact ${path}: lane must be one of tinker, vllm, or fireworks`);
  }
  if (object.sampling !== undefined && !SamplingSchema.safeParse(object.sampling).success) {
    throw new Error(`invalid serving lane artifact ${path}: sampling is not a valid sampling object`);
  }
  if (object.protocol_id !== undefined && !ToolProtocolSchema.shape.id.safeParse(object.protocol_id).success) {
    throw new Error(`invalid serving lane artifact ${path}: protocol_id is not a valid tool protocol`);
  }
  if (object.stop_sequences !== undefined
    && (!Array.isArray(object.stop_sequences) || object.stop_sequences.some((value) => typeof value !== "string"))) {
    throw new Error(`invalid serving lane artifact ${path}: stop_sequences must be an array of strings`);
  }
  const rowsPath = `${path}.rows`;
  const rows = Array.isArray(object.rows)
    ? object.rows.map((row, index) => {
      const result = EvalRowInputSchema.safeParse(row);
      if (!result.success) {
        throw new Error(`invalid eval row ${rowsPath}:${index + 1}: expected ${EVAL_RESULT_SCHEMA}, task_id, and numeric score`);
      }
      return result.data as EvalRow;
    })
    : [];
  return {
    lane: object.lane as ServingLane | undefined,
    rows,
    probes: Array.isArray(object.probes) ? object.probes : undefined,
    contract_fingerprint: typeof object.contract_fingerprint === "string" ? object.contract_fingerprint : undefined,
    observed_prompt: typeof object.observed_prompt === "string" ? object.observed_prompt : undefined,
    rendered_prompt_fingerprint: typeof object.rendered_prompt_fingerprint === "string"
      ? object.rendered_prompt_fingerprint : undefined,
    protocol_id: typeof object.protocol_id === "string" ? object.protocol_id as PreflightLaneInput["protocol_id"] : undefined,
    sampling: object.sampling as Sampling | undefined,
    stop_sequences: Array.isArray(object.stop_sequences) ? object.stop_sequences as string[] : undefined,
    acknowledged_deviations: Array.isArray(object.acknowledged_deviations)
      ? object.acknowledged_deviations as string[] : undefined,
    artifact_ref,
  };
}
