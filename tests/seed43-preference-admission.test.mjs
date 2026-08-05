import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEED43_PREFERENCE_REJECTION_CLASSES,
  admitSeed43PreferencePairs,
} from "../dist/seed43-preference-admission.js";

const hash = "a".repeat(64);

function pair(overrides = {}) {
  return {
    pairId: "pair-1",
    rowId: "row-1",
    promptHistorySha256: hash,
    actionRequired: true,
    chosenTokens: [1, 2, 3],
    rejectedTokens: [4, 5, 6],
    chosenToolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    expectedToolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    rejectionClass: "wrong_tool",
    sourceCapabilitySha256: hash,
    sourceRowIdSha256: hash,
    rendererSha256: hash,
    toolSchemaSha256: hash,
    runtimeSha256: hash,
    rejectedPayloadAvailable: true,
    ...overrides,
  };
}

describe("seed43 preference admission", () => {
  it("admits balanced, hash-bound pairs with exact chosen contracts", () => {
    const result = admitSeed43PreferencePairs([
      pair(),
      pair({
        pairId: "pair-2",
        rowId: "row-2",
        actionRequired: false,
        chosenToolCalls: [],
        expectedToolCalls: [],
        rejectionClass: "false_positive_mutation",
      }),
    ], ["wrong_tool", "false_positive_mutation"]);
    assert.equal(result.admitted, true);
    assert.equal(result.actionPairCount, 1);
    assert.equal(result.noActionPairCount, 1);
  });

  it("rejects missing rejected payloads, chosen mismatches, and imbalance", () => {
    const result = admitSeed43PreferencePairs([
      pair({
        rejectedPayloadAvailable: false,
        chosenToolCalls: [{ name: "write", arguments: { id: "wrong" }, effects: [] }],
      }),
      pair({ pairId: "pair-2", actionRequired: false, chosenToolCalls: [], expectedToolCalls: [] }),
      pair({ pairId: "pair-3", actionRequired: false, chosenToolCalls: [], expectedToolCalls: [] }),
    ]);
    assert.equal(result.admitted, false);
    assert.equal(result.rejectionClusters.missing_rejected_payload, 1);
    assert.equal(result.rejectionClusters.chosen_contract_mismatch, 1);
    assert.equal(result.rejectionClusters.no_action_dominates, 1);
  });

  it("recognizes the protected rejection classes", () => {
    assert.deepEqual([...SEED43_PREFERENCE_REJECTION_CLASSES], [
      "wrong_tool",
      "wrong_arguments_or_effects",
      "missing_continuation",
      "false_positive_mutation",
      "collapse_sentinel",
    ]);
  });
});
