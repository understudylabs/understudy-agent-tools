import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertionSatisfied,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
} from "../dist/automationbench-offline.js";
import {
  TASKS,
  fixtureSha256,
  splitCounts,
  splitSha256,
  taskPool,
} from "../experiments/on-event-email-orchestrator/src/wl07-fixture.mjs";

const validatorPath = new URL("../experiments/on-event-email-orchestrator/scripts/wl07-dpo-pairs-validate.mjs", import.meta.url);

describe("WL-07 synthetic event orchestration fixture", () => {
  it("has 72 deterministic tasks with the requested split boundary", () => {
    assert.equal(TASKS.length, 72);
    assert.deepEqual(splitCounts(), { train: 36, dev: 12, holdout: 24 });
    assert.match(fixtureSha256(), /^[0-9a-f]{64}$/);
    assert.equal(new Set(TASKS.map((task) => task.taskId)).size, TASKS.length);
  });

  it("scores every scripted oracle at one with no forbidden effects", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, task.taskId);
      assert.deepEqual(result.forbiddenEffects, [], task.taskId);
      assert.deepEqual(result.leakage, [], task.taskId);
      assert.ok(task.assertions.some((assertion) => !assertionSatisfied(task.initialState, assertion)), task.taskId);
    }
  });

  it("scores the deliberately wrong sentinel at zero", () => {
    for (const task of TASKS) {
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, task.taskId);
    }
  });

  it("keeps split membership disjoint and refuses unapproved holdout reads", () => {
    const train = taskPool({ split: "train" });
    const dev = taskPool({ split: "dev" });
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => taskPool({ split: "holdout", frozenHoldoutSha256: "wrong" }), /frozen-holdout refusal/);
    const holdout = taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") });
    const ids = (tasks) => new Set(tasks.map((task) => task.taskId));
    const trainIds = ids(train);
    const devIds = ids(dev);
    const holdoutIds = ids(holdout);
    assert.equal([...trainIds].some((id) => devIds.has(id) || holdoutIds.has(id)), false);
    assert.equal([...devIds].some((id) => holdoutIds.has(id)), false);
    assert.equal(new Set([...trainIds, ...devIds, ...holdoutIds]).size, 72);
  });

  it("resets deterministically", () => {
    for (const task of TASKS) {
      assert.equal(JSON.stringify(reset(task.taskId).obs), JSON.stringify(reset(task.taskId).obs), task.taskId);
    }
  });

  it("validates synthetic train pairs and refuses leakage, hash, private ids, duplicates, and no-signal rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "wl07-pairs-"));
    const task = TASKS.find((candidate) => candidate.split === "train");
    const pair = {
      task_id: task.taskId,
      prompt: task.prompt,
      chosen: '{"tool":"finish","arguments":{}}',
      rejected: '{"tool":"api_search","arguments":{"query":"unrelated"}}',
    };
    const pairsPath = join(dir, "pairs.jsonl");
    const manifestPath = join(dir, "manifest.json");
    const outputPath = join(dir, "normalized.jsonl");
    const writeCase = (row, manifestOverrides = {}) => {
      const bytes = `${JSON.stringify(row)}\n`;
      writeFileSync(pairsPath, bytes);
      writeFileSync(manifestPath, JSON.stringify({
        source: "synthetic WL-07 fixture",
        split: "train",
        train_split_sha256: splitSha256("train"),
        pairs_sha256: createHash("sha256").update(bytes).digest("hex"),
        ...manifestOverrides,
      }));
    };
    const run = () => execFileSync(process.execPath, [
      validatorPath.pathname,
      "--pairs", pairsPath,
      "--manifest", manifestPath,
      "--out", outputPath,
    ], { encoding: "utf8", stdio: "pipe" });

    writeCase(pair);
    assert.doesNotThrow(run);
    assert.equal(readFileSync(outputPath, "utf8").trim().length > 0, true);

    writeCase(pair, { pairs_sha256: "wrong" });
    assert.throws(run, /refusing to emit/);

    writeCase({ ...pair, task_id: TASKS.find((candidate) => candidate.split === "dev").taskId });
    assert.throws(run, /refusing to emit/);

    writeCase(pair, { source: "private production export" });
    assert.throws(run, /refusing to emit/);

    writeCase({ ...pair, chosen: `org${"_"}1234567890` });
    assert.throws(run, /refusing to emit/);

    const duplicateBytes = `${JSON.stringify(pair)}\n${JSON.stringify(pair)}\n`;
    writeFileSync(pairsPath, duplicateBytes);
    writeFileSync(manifestPath, JSON.stringify({
      source: "synthetic WL-07 fixture",
      split: "train",
      train_split_sha256: splitSha256("train"),
      pairs_sha256: createHash("sha256").update(duplicateBytes).digest("hex"),
    }));
    assert.throws(run, /refusing to emit/);

    writeCase({ ...pair, rejected: pair.chosen });
    assert.throws(run, /refusing to emit/);
  });
});
