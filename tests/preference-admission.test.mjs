import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PREFERENCE_REJECTION_CLASSES,
  admitPreferencePairs,
} from "../dist/preference-admission.js";

const hash = "a".repeat(64);
const allowlist = new Set(["row-1", "row-2"]);

function pair(overrides = {}) {
  return {
    pairId: "pair-1",
    rowId: "row-1",
    split: "train",
    promptHistorySha256: hash,
    actionRequired: true,
    actionFamily: "write",
    multiEffectContinuation: false,
    chosenTokens: [1, 2, 3],
    chosenToolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    expectedToolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
    expectedRejectionClass: "wrong_tool",
    rejectedPayloadSha256: "b".repeat(64),
    sourceCapabilitySha256: hash,
    allowedTrainRowIdsSha256: hash,
    sourceRowIdSha256: hash,
    rendererSha256: hash,
    toolSchemaSha256: hash,
    runtimeSha256: hash,
    ...overrides,
  };
}

function config(verifyRejectedPayload, overrides = {}) {
  return {
    expectedSourceCapabilitySha256: hash,
    expectedAllowedTrainRowIdsSha256: hash,
    allowedTrainRowIds: allowlist,
    expectedRendererSha256: hash,
    expectedToolSchemaSha256: hash,
    expectedRuntimeSha256: hash,
    requiredRejectionClasses: ["wrong_tool", "false_positive_mutation"],
    requiredActionFamilies: ["write"],
    requireMultiEffectContinuation: true,
    verifyRejectedPayload,
    ...overrides,
  };
}

function verified(overrides = {}) {
  return {
    payloadSha256: "b".repeat(64),
    classification: "wrong_tool",
    semantic: { kind: "no_action", toolCalls: [] },
    ...overrides,
  };
}

describe("preference admission", () => {
  it("admits verified, balanced, hash-bound pairs with family coverage", () => {
    const result = admitPreferencePairs([
      pair({ multiEffectContinuation: true }),
      pair({
        pairId: "pair-2",
        rowId: "row-2",
        actionRequired: false,
        actionFamily: undefined,
        chosenToolCalls: [],
        expectedToolCalls: [],
        expectedRejectionClass: "false_positive_mutation",
        rejectedPayloadSha256: "c".repeat(64),
      }),
    ], config((candidate) => candidate.pairId === "pair-1"
      ? verified()
      : verified({
        payloadSha256: "c".repeat(64),
        classification: "false_positive_mutation",
        semantic: { kind: "tool_calls", toolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }] },
      })));
    assert.equal(result.admitted, true);
  });

  it("fails closed on lied availability and nonhex hashes", () => {
    const result = admitPreferencePairs([
      pair({ rejectedPayloadSha256: "z".repeat(64) }),
    ], config(() => null, { requireMultiEffectContinuation: false }));
    assert.equal(result.admitted, false);
    assert.match(result.rejections.map((item) => item.reason).join(","), /invalid_sha256/);
    assert.match(result.rejections.map((item) => item.reason).join(","), /missing_rejected_payload_preimage/);
  });

  it("rejects duplicates, cross-split rows, mixed provenance, and semantic matches", () => {
    const result = admitPreferencePairs([
      pair({ pairId: "duplicate", split: "dev", runtimeSha256: "d".repeat(64) }),
      pair({ pairId: "duplicate", rowId: "row-2", sourceCapabilitySha256: "e".repeat(64) }),
      pair({ pairId: "duplicate-3" }),
    ], config(() => verified({
      semantic: { kind: "tool_calls", toolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }] },
    }), { requireMultiEffectContinuation: false }));
    assert.equal(result.admitted, false);
    const reasons = result.rejections.map((item) => item.reason).join(",");
    assert.match(reasons, /duplicate_pair_id/);
    assert.equal(result.rejections.filter((item) => item.reason === "duplicate_source_row_id").length, 1);
    assert.match(reasons, /row_outside_frozen_train_allowlist/);
    assert.match(reasons, /runtime_mismatch/);
    assert.match(reasons, /source_capability_mismatch/);
    assert.match(reasons, /identical_chosen_rejected_semantics/);
  });

  it("rejects the collapse sentinel for action-required rows", () => {
    const result = admitPreferencePairs([
      pair({ chosenTokens: [16071, 95597, 11] }),
    ], config(() => verified(), { requireMultiEffectContinuation: false }));
    assert.equal(result.admitted, false);
    assert.equal(result.rejections.filter((item) => item.reason === "chosen_collapse_sentinel").length, 1);
  });

  it("rejects every source-row occurrence after the first", () => {
    const result = admitPreferencePairs([
      pair({ pairId: "row-dup-1" }),
      pair({ pairId: "row-dup-2" }),
      pair({ pairId: "row-dup-3" }),
    ], config(() => verified(), { requireMultiEffectContinuation: false }));
    assert.equal(result.admitted, false);
    assert.equal(result.rejections.filter((item) => item.reason === "duplicate_source_row_id").length, 2);
  });

  it("rejects caller-mislabeled classes and reports global coverage failures", () => {
    const result = admitPreferencePairs([
      pair({ expectedRejectionClass: "false_positive_mutation" }),
    ], config(() => verified(), {
      requiredActionFamilies: ["read", "write"],
      requireMultiEffectContinuation: true,
      requiredRejectionClasses: [...PREFERENCE_REJECTION_CLASSES],
      desiredRejectionClasses: ["wrong_arguments_or_effects"],
    }));
    assert.equal(result.admitted, false);
    assert.match(result.rejections.map((item) => item.reason).join(","), /rejection_class_mismatch/);
    const globals = result.globalRejections.map((item) => item.reason).join(",");
    assert.match(globals, /missing_action_family:read/);
    assert.match(globals, /missing_multi_effect_continuation/);
    assert.match(globals, /missing_rejection_class:collapse_sentinel/);
    assert.deepEqual(result.missingDesiredRejectionClasses, ["wrong_arguments_or_effects"]);
  });

  it("accepts the no-action sentinel when the row contract is no-action", () => {
    const result = admitPreferencePairs([
      pair({
        multiEffectContinuation: true,
        expectedRejectionClass: "false_positive_mutation",
      }),
      pair({
        pairId: "pair-2",
        rowId: "row-2",
        actionRequired: false,
        actionFamily: undefined,
        chosenTokens: [16071, 95597, 11],
        chosenToolCalls: [],
        expectedToolCalls: [],
        expectedRejectionClass: "false_positive_mutation",
      }),
    ], config((candidate) => candidate.pairId === "pair-2"
      ? verified({
        classification: "false_positive_mutation",
        semantic: {
          kind: "tool_calls",
          toolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
        },
      })
      : verified({
        classification: "false_positive_mutation",
        semantic: { kind: "no_action", toolCalls: [] },
      }), {
      requireMultiEffectContinuation: false,
      requiredRejectionClasses: ["false_positive_mutation"],
    }));
    assert.equal(result.admitted, true);
  });

  it("distinguishes identical tokens with opposite action signs by semantic outcome", () => {
    const result = admitPreferencePairs([
      pair({ multiEffectContinuation: true }),
      pair({
        pairId: "pair-2",
        rowId: "row-2",
        actionRequired: false,
        actionFamily: undefined,
        chosenTokens: [16071, 95597, 11],
        chosenToolCalls: [],
        expectedToolCalls: [],
        expectedRejectionClass: "wrong_tool",
      }),
    ], config((candidate) => candidate.pairId === "pair-2"
      ? verified({
        semantic: {
          kind: "tool_calls",
          toolCalls: [{ name: "write", arguments: { id: "x" }, effects: ["updated:x"] }],
        },
      })
      : verified({
        semantic: { kind: "no_action", toolCalls: [] },
      }), {
      requireMultiEffectContinuation: false,
      requiredRejectionClasses: ["wrong_tool"],
    }));
    assert.equal(result.admitted, true);
  });
});
