import { createHash } from "node:crypto";

import { canonicalJson } from "../benchmark.js";

export const ARM_EVIDENCE_SCHEMA_VERSION = "understudy.arm_evidence.v1" as const;
export const EVAL_RESULT_SCHEMA_VERSION = "understudy.eval_result.v1" as const;
export const ARM_EVIDENCE_REQUIRED_FIELDS = [
  "schema_version",
  "arm_id",
  "run_id",
  "created_at",
  "base_model_id",
  "renderer",
  "provider",
  "dataset",
  "holdout",
  "entry_gate",
  "bands",
] as const;

export type EvalSplit = "train" | "dev" | "holdout" | "none" | null;
export type EvalResultRow = {
  schema_version?: string;
  run_id?: string;
  task_id?: string;
  split?: EvalSplit;
  score?: number | null;
  status?: "ok" | "error" | "skipped" | "unscored";
  [key: string]: unknown;
};

export type ArmEvidenceBand = {
  n: number;
  mean_score: number | null;
  [key: string]: unknown;
};

export type ArmEvidenceCheck = {
  id: string;
  status: "pass" | "fail";
  detail: string;
  [key: string]: unknown;
};

export type ArmEntryGate = {
  passed: boolean;
  oracle_mean: number;
  sentinel_max: number;
  sanity_task_ids: string[];
  checks: ArmEvidenceCheck[];
  [key: string]: unknown;
};

export type ArmEvidenceRow = {
  schema_version: typeof ARM_EVIDENCE_SCHEMA_VERSION;
  arm_id: string;
  run_id: string;
  created_at: string;
  base_model_id: string;
  renderer: string;
  provider: string;
  route?: string | null;
  training?: {
    lora_rank?: number | null;
    steps?: number | null;
    [key: string]: unknown;
  } | null;
  dataset: {
    seed?: number | null;
    sha256: string;
    [key: string]: unknown;
  };
  holdout: {
    split: EvalSplit;
    sealed_sha256: string;
    [key: string]: unknown;
  };
  cost?: {
    usd?: number | null;
    basis?: string | null;
    [key: string]: unknown;
  } | null;
  bands: Record<string, ArmEvidenceBand>;
  eval?: {
    rows: number;
    mean_score: number | null;
    eval_result_schema_version: typeof EVAL_RESULT_SCHEMA_VERSION;
    [key: string]: unknown;
  } | null;
  entry_gate: ArmEntryGate;
  provenance?: {
    harness_sha256?: string | null;
    split_sha256?: string | null;
    eval_rows_sha256?: string | null;
    artifact_refs?: string[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export type ArmEntryGateSpec = {
  sanityTaskIds: string[];
  oracle: (taskId: string) => Promise<number> | number;
  sentinel: (taskId: string) => Promise<number> | number;
  holdout: {
    expectedSha256: string;
    open: (hash?: string) => Promise<unknown> | unknown;
  };
};

export type BuildArmEvidenceInput = {
  arm_id: string;
  run_id: string;
  created_at: string;
  base_model_id: string;
  renderer: string;
  provider: string;
  route?: string | null;
  training?: ArmEvidenceRow["training"];
  dataset: ArmEvidenceRow["dataset"];
  holdout: ArmEvidenceRow["holdout"];
  cost?: ArmEvidenceRow["cost"];
  evalRows?: EvalResultRow[];
  bandOf?: (row: EvalResultRow) => string;
  entryGate: ArmEntryGate;
  provenance?: ArmEvidenceRow["provenance"];
  [key: string]: unknown;
};

export type ArmEvidenceIssue = {
  path: string;
  message: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNumberInRange(value: unknown, minimum = 0, maximum = 1): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function summarizeBands(
  rows: EvalResultRow[],
  bandOf: (row: EvalResultRow) => string = () => "all",
): Record<string, ArmEvidenceBand> {
  const grouped = new Map<string, { n: number; scores: number[] }>();
  for (const row of rows) {
    const band = bandOf(row);
    const group = grouped.get(band) ?? { n: 0, scores: [] };
    group.n += 1;
    if (typeof row.score === "number" && Number.isFinite(row.score)) group.scores.push(row.score);
    grouped.set(band, group);
  }
  return Object.fromEntries(
    [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([band, group]) => [
      band,
      { n: group.n, mean_score: mean(group.scores), unscored: group.n - group.scores.length },
    ]),
  );
}

export async function runArmEntryGate(spec: ArmEntryGateSpec): Promise<ArmEntryGate> {
  const taskIds = [...spec.sanityTaskIds];
  const checks: ArmEvidenceCheck[] = [];
  const oracleScores: number[] = [];
  const sentinelScores: number[] = [];

  if (taskIds.length === 0) {
    checks.push({ id: "sanity-tasks-present", status: "fail", detail: "sanityTaskIds must not be empty" });
  } else {
    for (const taskId of taskIds) {
      try {
        const score = await spec.oracle(taskId);
        oracleScores.push(score);
        checks.push({
          id: `oracle:${taskId}`,
          status: score === 1 ? "pass" : "fail",
          detail: `oracle reward = ${String(score)}; expected exactly 1.0`,
        });
      } catch (error) {
        checks.push({
          id: `oracle:${taskId}`,
          status: "fail",
          detail: `oracle call failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      try {
        const score = await spec.sentinel(taskId);
        sentinelScores.push(score);
        checks.push({
          id: `sentinel:${taskId}`,
          status: score === 0 ? "pass" : "fail",
          detail: `sentinel reward = ${String(score)}; expected exactly 0.0`,
        });
      } catch (error) {
        checks.push({
          id: `sentinel:${taskId}`,
          status: "fail",
          detail: `sentinel call failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  const expected = spec.holdout.expectedSha256;
  const wrongHash = expected === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
  let noHashFailed = false;
  try {
    await spec.holdout.open();
  } catch {
    noHashFailed = true;
  }
  checks.push({
    id: "holdout:no-hash",
    status: noHashFailed ? "pass" : "fail",
    detail: noHashFailed ? "open() refused without a hash" : "open() succeeded without a hash",
  });

  let wrongHashFailed = false;
  try {
    await spec.holdout.open(wrongHash);
  } catch {
    wrongHashFailed = true;
  }
  checks.push({
    id: "holdout:wrong-hash",
    status: wrongHashFailed ? "pass" : "fail",
    detail: wrongHashFailed ? "open(wrong hash) refused" : "open(wrong hash) succeeded",
  });

  let exactHashSucceeded = false;
  try {
    await spec.holdout.open(expected);
    exactHashSucceeded = true;
  } catch (error) {
    checks.push({
      id: "holdout:exact-hash",
      status: "fail",
      detail: `open(exact hash) failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (exactHashSucceeded) {
    checks.push({ id: "holdout:exact-hash", status: "pass", detail: "open(exact hash) succeeded" });
  }

  const oracleMean = mean(oracleScores) ?? 0;
  const sentinelMax = sentinelScores.length === 0 ? 1 : Math.max(...sentinelScores);
  return {
    passed: checks.length > 0 && checks.every((check) => check.status === "pass"),
    oracle_mean: oracleMean,
    sentinel_max: sentinelMax,
    sanity_task_ids: taskIds,
    checks,
  };
}

export async function assertArmEntryGate(spec: ArmEntryGateSpec): Promise<ArmEntryGate> {
  const gate = await runArmEntryGate(spec);
  if (!gate.passed) {
    const failures = gate.checks.filter((check) => check.status === "fail").map((check) => `- ${check.id}: ${check.detail}`);
    throw new Error(`arm entry gate failed\n${failures.join("\n")}`);
  }
  return gate;
}

export function buildArmEvidenceRow(input: BuildArmEvidenceInput): ArmEvidenceRow {
  if (!input.entryGate.passed) {
    throw new Error("cannot build arm evidence: entry gate did not pass");
  }
  const rows = input.evalRows ?? [];
  const scores = rows.flatMap((row) => typeof row.score === "number" && Number.isFinite(row.score) ? [row.score] : []);
  const row: ArmEvidenceRow = {
    schema_version: ARM_EVIDENCE_SCHEMA_VERSION,
    arm_id: input.arm_id,
    run_id: input.run_id,
    created_at: input.created_at,
    base_model_id: input.base_model_id,
    renderer: input.renderer,
    provider: input.provider,
    ...(input.route === undefined ? {} : { route: input.route }),
    ...(input.training === undefined ? {} : { training: input.training }),
    dataset: input.dataset,
    holdout: input.holdout,
    ...(input.cost === undefined ? {} : { cost: input.cost }),
    bands: summarizeBands(rows, input.bandOf),
    eval: {
      rows: rows.length,
      mean_score: mean(scores),
      eval_result_schema_version: EVAL_RESULT_SCHEMA_VERSION,
    },
    entry_gate: input.entryGate,
    provenance: {
      ...(input.provenance ?? {}),
      eval_rows_sha256: sha256(rows),
    },
  };
  assertArmEvidenceRow(row);
  return row;
}

export function validateArmEvidenceRow(row: unknown): ArmEvidenceIssue[] {
  const issues: ArmEvidenceIssue[] = [];
  const required = new Set<string>(ARM_EVIDENCE_REQUIRED_FIELDS);
  if (!isObject(row)) return [{ path: "$", message: "must be an object" }];
  for (const field of required) {
    if (!(field in row)) issues.push({ path: `$.${field}`, message: "required" });
  }
  if (row.schema_version !== ARM_EVIDENCE_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: `must be ${ARM_EVIDENCE_SCHEMA_VERSION}` });
  for (const field of ["arm_id", "run_id", "created_at", "base_model_id", "renderer", "provider"]) {
    if (field in row && (typeof row[field] !== "string" || row[field] === "")) issues.push({ path: `$.${field}`, message: "must be a non-empty string" });
  }
  if (!isObject(row.dataset)) {
    issues.push({ path: "$.dataset", message: "must be an object" });
  } else {
    if (!("seed" in row.dataset) || (row.dataset.seed !== null && !Number.isInteger(row.dataset.seed))) {
      issues.push({ path: "$.dataset.seed", message: "must be a nullable integer" });
    }
    if (!isSha256(row.dataset.sha256)) issues.push({ path: "$.dataset.sha256", message: "must be a lowercase 64-hex SHA-256" });
  }
  if (!isObject(row.holdout)) {
    issues.push({ path: "$.holdout", message: "must be an object" });
  } else {
    if (!["train", "dev", "holdout", "none", null].includes(row.holdout.split as EvalSplit)) issues.push({ path: "$.holdout.split", message: "outside split enum" });
    if (!isSha256(row.holdout.sealed_sha256)) issues.push({ path: "$.holdout.sealed_sha256", message: "must be a lowercase 64-hex SHA-256" });
  }
  if (!isObject(row.entry_gate)) {
    issues.push({ path: "$.entry_gate", message: "must be an object" });
  } else {
    if (typeof row.entry_gate.passed !== "boolean") issues.push({ path: "$.entry_gate.passed", message: "must be boolean" });
    if (!isNumberInRange(row.entry_gate.oracle_mean)) issues.push({ path: "$.entry_gate.oracle_mean", message: "must be a number from 0 to 1" });
    if (!isNumberInRange(row.entry_gate.sentinel_max)) issues.push({ path: "$.entry_gate.sentinel_max", message: "must be a number from 0 to 1" });
    if (!Array.isArray(row.entry_gate.sanity_task_ids)) issues.push({ path: "$.entry_gate.sanity_task_ids", message: "must be an array" });
    if (!Array.isArray(row.entry_gate.checks)) issues.push({ path: "$.entry_gate.checks", message: "must be an array" });
  }
  if (!isObject(row.bands)) {
    issues.push({ path: "$.bands", message: "must be an object" });
  } else {
    for (const [band, value] of Object.entries(row.bands)) {
      if (!isObject(value)) {
        issues.push({ path: `$.bands.${band}`, message: "must be an object" });
      } else {
        if (!Number.isInteger(value.n) || (value.n as number) < 0) issues.push({ path: `$.bands.${band}.n`, message: "must be a nonnegative integer" });
        if (value.mean_score !== null && !isNumberInRange(value.mean_score)) issues.push({ path: `$.bands.${band}.mean_score`, message: "must be null or a number from 0 to 1" });
      }
    }
  }
  if (row.eval !== undefined && row.eval !== null) {
    if (!isObject(row.eval)) issues.push({ path: "$.eval", message: "must be an object or null" });
    else {
      if (!Number.isInteger(row.eval.rows) || (row.eval.rows as number) < 0) issues.push({ path: "$.eval.rows", message: "must be a nonnegative integer" });
      if (row.eval.mean_score !== null && !isNumberInRange(row.eval.mean_score)) issues.push({ path: "$.eval.mean_score", message: "must be null or a number from 0 to 1" });
      if (row.eval.eval_result_schema_version !== EVAL_RESULT_SCHEMA_VERSION) issues.push({ path: "$.eval.eval_result_schema_version", message: `must be ${EVAL_RESULT_SCHEMA_VERSION}` });
    }
  }
  return issues;
}

export function assertArmEvidenceRow(row: unknown): asserts row is ArmEvidenceRow {
  const issues = validateArmEvidenceRow(row);
  if (issues.length > 0) throw new Error(`invalid arm evidence row\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
}
