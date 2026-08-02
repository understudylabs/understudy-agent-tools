import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TASKS,
  clearAugmentedTasks,
  fixtureSha256,
  registerAugmentedTasks,
  reset,
  rollout,
  sentinelPolicy,
  splitCounts,
  splitSha256,
  step,
  finish,
  taskContentSha256,
} from "../dist/automationbench-offline.js";
import { buildAugmentedTrainSet, trajectoryToolCalls } from "../dist/automationbench-train-augment.js";

const root = join(import.meta.dirname, "..");
const artifactRoot = join(root, "experiments/automationbench-train-augment/v1");
const frozenHashes = {
  fixture: "0341d79c3f12723c689e85ab08648671f884a5dbefbd3fa8a811603b17c4217f",
  train: "783dc3c1ccc25c6e6165a2f144cbdd27dd16c2bcb75626d47bc7a4ab9a5fdb89",
  dev: "5b8788501da98c52312de75472e89e545eeed146696e3612d3a023dd0cbfaedc",
  holdout: "a22a8e989ba9b081a73afae2c86e215b3bf56e4886676726e34d8693f5a62701",
};

function jsonl(value) {
  return `${value.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

describe("augmented AutomationBench train set", () => {
  it("preserves the frozen fixture and split contracts", () => {
    assert.equal(fixtureSha256(), frozenHashes.fixture);
    assert.deepEqual(splitCounts(), { train: 48, dev: 12, holdout: 12 });
    assert.equal(splitSha256("train"), frozenHashes.train);
    assert.equal(splitSha256("dev"), frozenHashes.dev);
    assert.equal(splitSha256("holdout"), frozenHashes.holdout);
    assert.equal(TASKS.length, 72);
  });

  it("is deterministic and emits the expected train growth", () => {
    const first = buildAugmentedTrainSet();
    const second = buildAugmentedTrainSet();
    assert.deepEqual(first, second);
    assert.equal(first.tasks.length, 336);
    assert.equal(first.tasks.filter((task) => task.split === "train").length, 336);
    assert.equal(first.trajectories.length, 1008);
  });

  it("passes gates and keeps augmented content disjoint from dev and holdout", () => {
    const set = buildAugmentedTrainSet();
    const augmented = set.tasks.slice(48);
    assert.equal(augmented.length, 288);
    for (const task of augmented) {
      assert.equal(task.split, "train");
      assert.equal(rollout(task.taskId, (obs) => task.oracle[obs.step] ?? null).reward, 1);
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0);
      assert.ok(task.allowedWrites.every((path) => !path.startsWith("crm.contacts.c-0")));
    }
    assert.deepEqual(set.contamination.train_vs_dev_ids, []);
    assert.deepEqual(set.contamination.train_vs_holdout_ids, []);
    assert.deepEqual(set.contamination.train_vs_dev_content_hashes, []);
    assert.deepEqual(set.contamination.train_vs_holdout_content_hashes, []);
    assert.deepEqual(set.contamination.train_vs_v2_dev_ids, []);
    assert.deepEqual(set.contamination.train_vs_v2_holdout_ids, []);
    assert.deepEqual(set.contamination.train_vs_v2_dev_content_hashes, []);
    assert.deepEqual(set.contamination.train_vs_v2_holdout_content_hashes, []);
    assert.equal(set.contamination.holdout_hash_equal, true);
    assert.equal(set.contamination.v2_holdout_hash_equal, true);
    assert.deepEqual(Object.keys(set.manifest.task_content_sha256[0]).sort(), ["content_sha256", "task_id"]);
    for (const task of augmented) assert.ok(!task.prompt.includes("phrasing variant"));
  });

  it("replays every emitted trajectory to exactly 1.0", () => {
    const set = buildAugmentedTrainSet();
    for (const trajectory of set.trajectories) {
      const { handle } = reset(trajectory.task_id);
      let lastResult = null;
      for (const call of trajectoryToolCalls(trajectory)) {
        lastResult = step(handle, call);
        if (lastResult.done) break;
      }
      const result = handle.done ? lastResult : finish(handle);
      assert.equal(result.reward, 1, `${trajectory.task_id} variant ${trajectory.variant}`);
      assert.deepEqual(handle.forbiddenEffects, []);
    }
  });

  it("refuses non-train and frozen-id/content collisions in the registry", () => {
    clearAugmentedTasks();
    const frozen = TASKS[0];
    assert.throws(() => registerAugmentedTasks([{ ...frozen, split: "dev" }]), /train-only/);
    assert.throws(() => registerAugmentedTasks([{ ...frozen, split: "train" }]), /id collides/);
    assert.throws(() => registerAugmentedTasks([{ ...frozen, taskId: "simple-api-test-aug-001", split: "train" }]), /content collides/);
    buildAugmentedTrainSet();
  });

  it("matches committed artifacts", () => {
    const set = buildAugmentedTrainSet();
    assert.equal(readFileSync(join(artifactRoot, "tasks.jsonl"), "utf8"), jsonl(set.tasks));
    assert.equal(readFileSync(join(artifactRoot, "trajectories.jsonl"), "utf8"), jsonl(set.trajectories));
    assert.equal(JSON.parse(readFileSync(join(artifactRoot, "manifest.json"), "utf8")).augmented_train_sha256, set.manifest.augmented_train_sha256);
    assert.deepEqual(JSON.parse(readFileSync(join(artifactRoot, "contamination-report.json"), "utf8")), set.contamination);
    assert.equal(set.manifest.task_content_sha256.length, 336);
    assert.deepEqual(set.manifest.per_family_accepted, Object.fromEntries(Object.keys(set.manifest.generator.family_bands).map((slug) => [slug, 24])));
    assert.equal(set.tasks.slice(48).map(taskContentSha256).length, 288);
  });
});
