import { createHash } from "node:crypto";

export type PreferenceToolCall = {
  name: string;
  arguments: unknown;
  effects: readonly string[];
};

export type Seed43PreferencePair = {
  pairId: string;
  rowId: string;
  promptHistorySha256: string;
  actionRequired: boolean;
  chosenTokens: readonly number[];
  rejectedTokens: readonly number[];
  chosenToolCalls: readonly PreferenceToolCall[];
  expectedToolCalls: readonly PreferenceToolCall[];
  rejectionClass: string;
  sourceCapabilitySha256: string;
  sourceRowIdSha256: string;
  rendererSha256: string;
  toolSchemaSha256: string;
  runtimeSha256: string;
  rejectedPayloadAvailable: boolean;
};

export type Seed43PreferenceAdmissionResult = {
  admitted: boolean;
  pairCount: number;
  actionPairCount: number;
  noActionPairCount: number;
  rejectionClusters: Record<string, number>;
  rejectedPairIds: string[];
};

export const SEED43_PREFERENCE_REJECTION_CLASSES = Object.freeze([
  "wrong_tool",
  "wrong_arguments_or_effects",
  "missing_continuation",
  "false_positive_mutation",
  "collapse_sentinel",
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sameToolCall(actual: PreferenceToolCall, expected: PreferenceToolCall): boolean {
  return actual.name === expected.name
    && stableJson(actual.arguments) === stableJson(expected.arguments)
    && stableJson(actual.effects) === stableJson(expected.effects);
}

function hasToolContract(pair: Seed43PreferencePair): boolean {
  return pair.chosenToolCalls.length > 0
    && pair.chosenToolCalls.length === pair.expectedToolCalls.length
    && pair.chosenToolCalls.every((call, index) => sameToolCall(call, pair.expectedToolCalls[index]));
}

function reject(
  clusters: Record<string, number>,
  rejectedPairIds: string[],
  pairId: string,
  cluster: string,
): void {
  clusters[cluster] = (clusters[cluster] ?? 0) + 1;
  rejectedPairIds.push(pairId);
}

export function sha256TokenSequence(tokens: readonly number[]): string {
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

export function admitSeed43PreferencePairs(
  pairs: readonly Seed43PreferencePair[],
  protectedRejectionClasses: readonly string[] = SEED43_PREFERENCE_REJECTION_CLASSES,
): Seed43PreferenceAdmissionResult {
  const rejectionClusters: Record<string, number> = {};
  const rejectedPairIds: string[] = [];
  let actionPairCount = 0;
  let noActionPairCount = 0;
  const observedRejectionClasses = new Set<string>();

  for (const pair of pairs) {
    if (pair.actionRequired) actionPairCount += 1;
    else noActionPairCount += 1;
    observedRejectionClasses.add(pair.rejectionClass);

    if (pair.chosenTokens.length === 0 || pair.rejectedTokens.length === 0) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "empty_preference_side");
    }
    if (sha256TokenSequence(pair.chosenTokens) === sha256TokenSequence(pair.rejectedTokens)) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "identical_chosen_rejected");
    }
    if (pair.actionRequired ? !hasToolContract(pair) : pair.chosenToolCalls.length > 0) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "chosen_contract_mismatch");
    }
    if (pair.chosenTokens.length === 3
      && pair.chosenTokens[0] === 16071
      && pair.chosenTokens[1] === 95597
      && pair.chosenTokens[2] === 11) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "chosen_collapse_sentinel");
    }
    if (!SEED43_PREFERENCE_REJECTION_CLASSES.includes(pair.rejectionClass)) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "unknown_rejection_class");
    }
    if (!pair.rejectedPayloadAvailable) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "missing_rejected_payload");
    }
    if (pair.promptHistorySha256.length !== 64
      || pair.sourceCapabilitySha256.length !== 64
      || pair.sourceRowIdSha256.length !== 64
      || pair.rendererSha256.length !== 64
      || pair.toolSchemaSha256.length !== 64
      || pair.runtimeSha256.length !== 64) {
      reject(rejectionClusters, rejectedPairIds, pair.pairId, "missing_provenance_hash");
    }
  }

  if (pairs.length === 0) rejectionClusters.missing_pairs = 1;
  if (noActionPairCount > actionPairCount) rejectionClusters.no_action_dominates = 1;
  const missingClasses = protectedRejectionClasses.filter((item) => !observedRejectionClasses.has(item));
  if (missingClasses.length > 0) rejectionClusters.missing_rejection_class = missingClasses.length;

  return {
    admitted: Object.keys(rejectionClusters).length === 0,
    pairCount: pairs.length,
    actionPairCount,
    noActionPairCount,
    rejectionClusters,
    rejectedPairIds,
  };
}
