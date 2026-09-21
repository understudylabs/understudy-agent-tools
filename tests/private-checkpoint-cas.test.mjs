import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  orderCheckpointReceipts,
  readPrivateCheckpoint,
  writePrivateCheckpoint,
} from "../dist/private-checkpoint-cas.js";

describe("private checkpoint CAS", () => {
  it("stores restore preimages privately while receipts expose hashes only", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-checkpoint-cas-"));
    try {
      const receipt = writePrivateCheckpoint(root, {
        checkpointId: "step-14",
        restorePath: "tinker://private/opaque/step-14",
        step: 14,
      });
      assert.equal(Object.hasOwn(receipt, "restorePath"), false);
      assert.equal(readPrivateCheckpoint(root, receipt).restorePath, "tinker://private/opaque/step-14");
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "step-14.json")).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(root, "step-14.json"), "utf8").includes(receipt.restorePathSha256), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports zero-network ordered ladder resume and detects tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "understudy-checkpoint-ladder-"));
    try {
      const receipts = [1, 14, 25, 41].map((step) => writePrivateCheckpoint(root, {
        checkpointId: `step-${step}`,
        restorePath: `tinker://private/opaque/step-${step}`,
        step,
      }));
      assert.deepEqual(orderCheckpointReceipts([...receipts].reverse()).map((item) => item.step), [1, 14, 25, 41]);
      const tampered = { ...receipts[0], restorePathSha256: "0".repeat(64) };
      assert.throws(() => readPrivateCheckpoint(root, tampered), /hash mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
