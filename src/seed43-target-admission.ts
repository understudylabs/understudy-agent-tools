import { createHash } from "node:crypto";

export const SEED43_COLLAPSE_SENTINEL = Object.freeze([16071, 95597, 11]);

export type Seed43ToolCall = {
  name: string;
  arguments: unknown;
  effects: readonly string[];
};

export type Seed43TargetRecord = {
  rowId: string;
  actionRequired: boolean;
  servingInputSha256: string;
  trainingInputSha256: string;
  targetTokens: readonly number[];
  targetText?: string;
  toolCalls: readonly Seed43ToolCall[];
  expectedToolCalls: readonly Seed43ToolCall[];
  failureFamily?: string;
};

export type Seed43AdmissionResult = {
  admitted: boolean;
  actionRequiredCount: number;
  noActionCount: number;
  protectedFailureFamilies: string[];
  rejectionClusters: Record<string, number>;
  rejectedRowIds: string[];
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sameToolCall(actual: Seed43ToolCall, expected: Seed43ToolCall): boolean {
  return actual.name === expected.name
    && stableJson(actual.arguments) === stableJson(expected.arguments)
    && stableJson(actual.effects) === stableJson(expected.effects);
}

function reject(
  clusters: Record<string, number>,
  rejectedRowIds: string[],
  rowId: string,
  cluster: string,
): void {
  clusters[cluster] = (clusters[cluster] ?? 0) + 1;
  rejectedRowIds.push(rowId);
}

export function sha256TokenSequence(tokens: readonly number[]): string {
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

export function isCollapseSentinel(tokens: readonly number[]): boolean {
  return stableJson(tokens) === stableJson(SEED43_COLLAPSE_SENTINEL);
}

export function admitSeed43Targets(
  records: readonly Seed43TargetRecord[],
  protectedFailureFamilies: readonly string[],
): Seed43AdmissionResult {
  const rejectionClusters: Record<string, number> = {};
  const rejectedRowIds: string[] = [];
  let actionRequiredCount = 0;
  let noActionCount = 0;

  for (const row of records) {
    if (row.actionRequired) actionRequiredCount += 1;
    else noActionCount += 1;

    if (row.servingInputSha256 !== row.trainingInputSha256) {
      reject(rejectionClusters, rejectedRowIds, row.rowId, "input_serialization_mismatch");
    }
    if (isCollapseSentinel(row.targetTokens)) {
      reject(rejectionClusters, rejectedRowIds, row.rowId, "collapse_sentinel");
    }

    if (row.actionRequired) {
      if (row.toolCalls.length === 0) {
        reject(rejectionClusters, rejectedRowIds, row.rowId, "action_without_tool_call");
      } else if (row.toolCalls.length !== row.expectedToolCalls.length) {
        reject(rejectionClusters, rejectedRowIds, row.rowId, "tool_call_count_mismatch");
      } else if (row.toolCalls.some((call, index) => !sameToolCall(call, row.expectedToolCalls[index]))) {
        reject(rejectionClusters, rejectedRowIds, row.rowId, "tool_call_contract_mismatch");
      }
      if (row.targetText?.trim() === "NO_ACTION") {
        reject(rejectionClusters, rejectedRowIds, row.rowId, "positive_no_action_text");
      }
    } else if (row.toolCalls.length > 0) {
      reject(rejectionClusters, rejectedRowIds, row.rowId, "no_action_with_tool_call");
    }
  }

  if (actionRequiredCount === 0) {
    rejectionClusters.missing_action_rows = 1;
  }
  if (noActionCount > actionRequiredCount) {
    rejectionClusters.no_action_dominates = 1;
  }
  const observedFamilies = new Set(
    records
      .filter((row) => !row.actionRequired && row.failureFamily)
      .map((row) => row.failureFamily as string),
  );
  const missingFamilies = protectedFailureFamilies.filter((family) => !observedFamilies.has(family));
  if (missingFamilies.length > 0) {
    rejectionClusters.missing_protected_failure_family = missingFamilies.length;
  }

  return {
    admitted: Object.keys(rejectionClusters).length === 0,
    actionRequiredCount,
    noActionCount,
    protectedFailureFamilies: [...observedFamilies].sort(),
    rejectionClusters,
    rejectedRowIds,
  };
}
