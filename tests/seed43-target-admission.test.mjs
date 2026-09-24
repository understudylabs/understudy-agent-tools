import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEED43_COLLAPSE_SENTINEL,
  admitSeed43Targets,
  isCollapseSentinel,
} from "../dist/seed43-target-admission.js";

const hash = "a".repeat(64);

function action(overrides = {}) {
  return {
    rowId: "action-1",
    actionRequired: true,
    servingInputSha256: hash,
    trainingInputSha256: hash,
    targetTokens: [1, 2, 3],
    toolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    expectedToolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    ...overrides,
  };
}

function noop(overrides = {}) {
  return {
    rowId: "noop-1",
    actionRequired: false,
    servingInputSha256: hash,
    trainingInputSha256: hash,
    targetTokens: [4, 5],
    toolCalls: [],
    expectedToolCalls: [],
    failureFamily: "legitimate_noop",
    ...overrides,
  };
}

describe("seed43 target admission", () => {
  it("rejects the seed42 three-token collapse sentinel", () => {
    assert.equal(isCollapseSentinel(SEED43_COLLAPSE_SENTINEL), true);
    assert.equal(isCollapseSentinel([16071, 95597, 12]), false);
  });

  it("requires action rows to round-trip to the exact tool contract", () => {
    const result = admitSeed43Targets([action(), noop()], ["legitimate_noop"]);
    assert.equal(result.admitted, true);
  });

  it("rejects text-only positive targets and serialization drift", () => {
    const result = admitSeed43Targets([
      action({ targetText: "NO_ACTION", trainingInputSha256: "b".repeat(64) }),
      noop(),
    ], ["legitimate_noop"]);
    assert.equal(result.admitted, false);
    assert.equal(result.rejectionClusters.input_serialization_mismatch, 1);
    assert.equal(result.rejectionClusters.positive_no_action_text, 1);
  });

  it("rejects action/no-action sign inversions and dominance", () => {
    const result = admitSeed43Targets([
      action({ toolCalls: [] }),
      noop({ rowId: "noop-2" }),
      noop({ rowId: "noop-3" }),
    ], ["legitimate_noop"]);
    assert.equal(result.admitted, false);
    assert.equal(result.rejectionClusters.action_without_tool_call, 1);
    assert.equal(result.rejectionClusters.no_action_dominates, 1);
  });
});
