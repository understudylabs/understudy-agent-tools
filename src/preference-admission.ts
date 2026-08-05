import { createHash } from "node:crypto";

export type PreferenceToolCall = {
  name: string;
  arguments: unknown;
  effects: readonly string[];
};

export type PreferenceSemantic = {
  kind: "tool_calls" | "no_action";
  toolCalls: readonly PreferenceToolCall[];
};

export type PreferencePair = {
  pairId: string;
  rowId: string;
  split: "train" | "dev" | "holdout";
  promptHistorySha256: string;
  actionRequired: boolean;
  actionFamily?: string;
  multiEffectContinuation: boolean;
  chosenTokens: readonly number[];
  chosenToolCalls: readonly PreferenceToolCall[];
  expectedToolCalls: readonly PreferenceToolCall[];
  expectedRejectionClass: string;
  rejectedPayloadSha256: string;
  sourceCapabilitySha256: string;
  allowedTrainRowIdsSha256: string;
  sourceRowIdSha256: string;
  rendererSha256: string;
  toolSchemaSha256: string;
  runtimeSha256: string;
};

export type VerifiedRejectedPayload = {
  payloadSha256: string;
  classification: string;
  semantic: PreferenceSemantic;
};

export type PreferenceAdmissionConfig = {
  expectedSourceCapabilitySha256: string;
  expectedAllowedTrainRowIdsSha256: string;
  allowedTrainRowIds: ReadonlySet<string>;
  expectedRendererSha256: string;
  expectedToolSchemaSha256: string;
  expectedRuntimeSha256: string;
  requiredRejectionClasses: readonly string[];
  desiredRejectionClasses?: readonly string[];
  requiredActionFamilies?: readonly string[];
  requireMultiEffectContinuation?: boolean;
  allowMultipleRejectionsPerRow?: boolean;
  verifyRejectedPayload: (pair: PreferencePair) => VerifiedRejectedPayload | null;
};

export type PreferenceAdmissionRejection = {
  pairId: string | null;
  rowId?: string;
  reason: string;
};

export type PreferenceAdmissionResult = {
  admitted: boolean;
  pairCount: number;
  actionPairCount: number;
  noActionPairCount: number;
  rejectionClusters: Record<string, number>;
  rejectedPairIds: string[];
  rejections: PreferenceAdmissionRejection[];
  globalRejections: PreferenceAdmissionRejection[];
  missingDesiredRejectionClasses: string[];
};

export const PREFERENCE_REJECTION_CLASSES = Object.freeze([
  "wrong_tool",
  "wrong_arguments_or_effects",
  "missing_continuation",
  "false_positive_mutation",
  "collapse_sentinel",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function semanticForChosen(pair: PreferencePair): PreferenceSemantic {
  return {
    kind: pair.actionRequired ? "tool_calls" : "no_action",
    toolCalls: pair.chosenToolCalls,
  };
}

function sameToolCall(actual: PreferenceToolCall, expected: PreferenceToolCall): boolean {
  return actual.name === expected.name
    && stableJson(actual.arguments) === stableJson(expected.arguments)
    && stableJson(actual.effects) === stableJson(expected.effects);
}

function sameSemantic(left: PreferenceSemantic, right: PreferenceSemantic): boolean {
  return left.kind === right.kind
    && left.toolCalls.length === right.toolCalls.length
    && left.toolCalls.every((call, index) => sameToolCall(call, right.toolCalls[index]));
}

function hasToolContract(pair: PreferencePair): boolean {
  return pair.actionRequired
    ? pair.chosenToolCalls.length > 0
      && pair.chosenToolCalls.length === pair.expectedToolCalls.length
      && pair.chosenToolCalls.every((call, index) => sameToolCall(call, pair.expectedToolCalls[index]))
    : pair.chosenToolCalls.length === 0 && pair.expectedToolCalls.length === 0;
}

function addRejection(
  result: {
    rejectionClusters: Record<string, number>;
    rejectedPairIds: string[];
    rejections: PreferenceAdmissionRejection[];
  },
  pair: PreferencePair,
  reason: string,
): void {
  result.rejectionClusters[reason] = (result.rejectionClusters[reason] ?? 0) + 1;
  result.rejectedPairIds.push(pair.pairId);
  result.rejections.push({ pairId: pair.pairId, rowId: pair.rowId, reason });
}

function addGlobalRejection(
  result: {
    rejectionClusters: Record<string, number>;
    globalRejections: PreferenceAdmissionRejection[];
  },
  reason: string,
  pairIds: readonly string[],
): void {
  result.rejectionClusters[reason] = (result.rejectionClusters[reason] ?? 0) + 1;
  result.globalRejections.push({ pairId: null, rowId: pairIds.join(","), reason });
}

export function sha256TokenSequence(tokens: readonly number[]): string {
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function admitPreferencePairs(
  pairs: readonly PreferencePair[],
  config: PreferenceAdmissionConfig,
): PreferenceAdmissionResult {
  const result = {
    rejectionClusters: {} as Record<string, number>,
    rejectedPairIds: [] as string[],
    rejections: [] as PreferenceAdmissionRejection[],
    globalRejections: [] as PreferenceAdmissionRejection[],
  };
  let actionPairCount = 0;
  let noActionPairCount = 0;
  const rowIds = new Map<string, string[]>();
  const pairIds = new Set<string>();
  const observedClasses = new Set<string>();
  const observedFamilies = new Set<string>();
  const globalPairIds = pairs.map((pair) => pair.pairId);

  for (const pair of pairs) {
    if (pair.actionRequired) actionPairCount += 1;
    else noActionPairCount += 1;
    rowIds.set(pair.rowId, [...(rowIds.get(pair.rowId) ?? []), pair.pairId]);

    if (pairIds.has(pair.pairId)) addRejection(result, pair, "duplicate_pair_id");
    pairIds.add(pair.pairId);
    if (!config.allowMultipleRejectionsPerRow && rowIds.get(pair.rowId)?.length === 2) {
      addRejection(result, pair, "duplicate_source_row_id");
    }
    if (pair.split !== "train" || !config.allowedTrainRowIds.has(pair.rowId)) {
      addRejection(result, pair, "row_outside_frozen_train_allowlist");
    }
    if (pair.sourceCapabilitySha256 !== config.expectedSourceCapabilitySha256) {
      addRejection(result, pair, "source_capability_mismatch");
    }
    if (pair.allowedTrainRowIdsSha256 !== config.expectedAllowedTrainRowIdsSha256) {
      addRejection(result, pair, "allowlist_hash_mismatch");
    }
    if (pair.rendererSha256 !== config.expectedRendererSha256) addRejection(result, pair, "renderer_mismatch");
    if (pair.toolSchemaSha256 !== config.expectedToolSchemaSha256) addRejection(result, pair, "tool_schema_mismatch");
    if (pair.runtimeSha256 !== config.expectedRuntimeSha256) addRejection(result, pair, "runtime_mismatch");

    const hashes = [
      pair.promptHistorySha256,
      pair.rejectedPayloadSha256,
      pair.sourceCapabilitySha256,
      pair.allowedTrainRowIdsSha256,
      pair.sourceRowIdSha256,
      pair.rendererSha256,
      pair.toolSchemaSha256,
      pair.runtimeSha256,
    ];
    if (hashes.some((hash) => !isSha256(hash))) addRejection(result, pair, "invalid_sha256");
    if (pair.actionRequired && pair.actionFamily) observedFamilies.add(pair.actionFamily);
    if (!hasToolContract(pair)) addRejection(result, pair, "chosen_contract_mismatch");
    if (pair.actionRequired
      && pair.chosenTokens.length === 3
      && pair.chosenTokens[0] === 16071
      && pair.chosenTokens[1] === 95597
      && pair.chosenTokens[2] === 11) {
      addRejection(result, pair, "chosen_collapse_sentinel");
    }
    if (pair.actionRequired
      && pair.chosenTokens.length === 3
      && pair.chosenTokens[0] === 16071
      && pair.chosenTokens[1] === 95597
      && pair.chosenTokens[2] === 11) {
      addRejection(result, pair, "chosen_collapse_sentinel");
    }

    const verified = config.verifyRejectedPayload(pair);
    if (verified === null) {
      addRejection(result, pair, "missing_rejected_payload_preimage");
      continue;
    }
    if (!isSha256(verified.payloadSha256) || verified.payloadSha256 !== pair.rejectedPayloadSha256) {
      addRejection(result, pair, "rejected_payload_hash_mismatch");
    }
    if (verified.classification !== pair.expectedRejectionClass) {
      addRejection(result, pair, "rejection_class_mismatch");
    }
    if (!PREFERENCE_REJECTION_CLASSES.includes(verified.classification)) {
      addRejection(result, pair, "unknown_rejection_class");
    }
    observedClasses.add(verified.classification);
    if (sameSemantic(semanticForChosen(pair), verified.semantic)) {
      addRejection(result, pair, "identical_chosen_rejected_semantics");
    }
  }

  if (pairs.length === 0) addGlobalRejection(result, "missing_pairs", globalPairIds);
  if (noActionPairCount > actionPairCount) addGlobalRejection(result, "no_action_dominates", globalPairIds);
  if (actionPairCount === 0) addGlobalRejection(result, "missing_action_pairs", globalPairIds);
  for (const requiredFamily of config.requiredActionFamilies ?? []) {
    if (!observedFamilies.has(requiredFamily)) {
      addGlobalRejection(result, `missing_action_family:${requiredFamily}`, globalPairIds);
    }
  }
  if (config.requireMultiEffectContinuation && !pairs.some((pair) => pair.actionRequired && pair.multiEffectContinuation)) {
    addGlobalRejection(result, "missing_multi_effect_continuation", globalPairIds);
  }
  for (const requiredClass of config.requiredRejectionClasses) {
    if (!observedClasses.has(requiredClass)) {
      addGlobalRejection(result, `missing_rejection_class:${requiredClass}`, globalPairIds);
    }
  }
  const missingDesiredRejectionClasses = (config.desiredRejectionClasses ?? [])
    .filter((desiredClass) => !observedClasses.has(desiredClass));

  return {
    admitted: result.rejections.length === 0 && result.globalRejections.length === 0,
    pairCount: pairs.length,
    actionPairCount,
    noActionPairCount,
    ...result,
    missingDesiredRejectionClasses,
  };
}
