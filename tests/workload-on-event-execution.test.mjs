import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GUARD_CONTACT,
  assertionSatisfied,
  oraclePolicy,
  reset,
  rollout,
  sentinelPolicy,
  step,
} from "../dist/automationbench-offline.js";
import {
  OEE_TASKS,
  WORKLOAD_OEE,
  oeeFixtureSha256,
  oeeScenarioSha256,
  oeeSplitCounts,
  oeeSplitSha256,
  oeeSplitManifest,
  oeeTaskBands,
  oeeTaskPool,
} from "../dist/workload-on-event-execution.js";
import { v2FixtureSha256, v2SplitSha256 } from "../dist/automationbench-v2.js";

const FROZEN_HOLDOUT_SHA256 = "ff1438e7c257bb39a8880220b8d2c1787f360d01010f7b1d39f960fa58aed868";
const FIXTURE_SHA256 = "8cfffb5500f40c03a8394d3f244b3277a20a4815faead4def326236a7e511190";
const TRAIN_SHA256 = "9f14b02edf307ca215ecbc70d716786d55794bc2332727abe71d142ec5e764c7";
const DEV_SHA256 = "74a6cdbfe6a5ec504e82dc0ce550a91300a5a6f705ec7ce402b063382abf79f5";

const V2_FIXTURE_SHA256 = "918023a1c2f342ea33e99251ff1f2e5f489c9c4f24e5412a774d97ec2d36cd22";
const V2_HOLDOUT_SHA256 = "2f8d0fa9478e47fbb609023918206bc7edbd25ec0992d2ccca945962a2a889c9";

const READS = [
  { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/drafts" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/mail/messages" } },
  { name: "api_fetch", arguments: { method: "GET", url: "/support/tickets" } },
];

function discoverableText(task) {
  const { handle, obs } = reset(task.taskId);
  return READS.reduce((text, call) => text + step(handle, call).obs.messages.at(-1).content, JSON.stringify(obs.messages));
}

describe("on-event-execution synthetic fixture", () => {
  it("has the pinned shape and positional split", () => {
    assert.equal(OEE_TASKS.length, 96);
    assert.deepEqual(oeeSplitCounts(), { train: 56, dev: 16, holdout: 24 });
    assert.equal(new Set(OEE_TASKS.map((task) => task.taskId)).size, OEE_TASKS.length);
    assert.ok(OEE_TASKS.every((task) => task.taskId.startsWith("oee-")));
    assert.equal(WORKLOAD_OEE.fixture_id, "on-event-execution-offline-v1");
  });

  it("has unique scenario signatures with no cross-split contamination", () => {
    const signatures = new Map();
    for (const task of OEE_TASKS) {
      const signature = oeeScenarioSha256(task);
      assert.equal(signatures.has(signature), false, `duplicate scenario: ${task.taskId}`);
      signatures.set(signature, task);
    }
    const signaturesBySplit = new Map();
    for (const task of OEE_TASKS) {
      const splitSignatures = signaturesBySplit.get(task.split) ?? new Set();
      splitSignatures.add(oeeScenarioSha256(task));
      signaturesBySplit.set(task.split, splitSignatures);
    }
    for (const [split, signaturesForSplit] of signaturesBySplit) {
      for (const [otherSplit, signaturesForOtherSplit] of signaturesBySplit) {
        if (split >= otherSplit) continue;
        for (const signature of signaturesForSplit) {
          assert.equal(signaturesForOtherSplit.has(signature), false, `cross-split contamination: ${split} / ${otherSplit}`);
        }
      }
    }
  });

  it("pins fixture and split hashes", () => {
    assert.equal(oeeFixtureSha256(), FIXTURE_SHA256);
    assert.equal(oeeSplitSha256("train"), TRAIN_SHA256);
    assert.equal(oeeSplitSha256("dev"), DEV_SHA256);
    assert.equal(oeeSplitSha256("holdout"), FROZEN_HOLDOUT_SHA256);
  });

  it("keeps the v2 hashes unchanged", () => {
    assert.equal(v2FixtureSha256(), V2_FIXTURE_SHA256);
    assert.equal(v2SplitSha256("holdout"), V2_HOLDOUT_SHA256);
  });

  it("scores the oracle exactly and the sentinel at zero", () => {
    for (const task of OEE_TASKS) {
      assert.equal(rollout(task.taskId, oraclePolicy(task.taskId)).reward, 1, `${task.taskId} oracle`);
      assert.equal(rollout(task.taskId, sentinelPolicy()).reward, 0, `${task.taskId} sentinel`);
    }
  });

  it("has no free credit, guard writes, or assertion-path leakage", () => {
    for (const task of OEE_TASKS) {
      assert.ok(task.assertions.some((assertion) => !assertionSatisfied(task.initialState, assertion)), `${task.taskId} pre-satisfied`);
      assert.ok(task.allowedWrites.every((write) => !write.includes(`contacts.${GUARD_CONTACT.id}`)), `${task.taskId} guard write`);
      for (const assertion of task.assertions) {
        if (assertion.kind === "equals") assert.ok(!task.prompt.includes(assertion.path), `${task.taskId} assertion path`);
      }
    }
  });

  it("has readable endpoint surfaces and deterministic reset", () => {
    for (const task of OEE_TASKS) {
      assert.equal(JSON.stringify(reset(task.taskId).obs), JSON.stringify(reset(task.taskId).obs), `${task.taskId} reset`);
      assert.ok(discoverableText(task).length > task.prompt.length, `${task.taskId} has no readable observation`);
    }
  });

  it("refuses holdout access without the exact hash", () => {
    assert.throws(() => oeeTaskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => oeeTaskPool({ split: "holdout", frozenHoldoutSha256: "nope" }), /frozen-holdout refusal/);
    assert.equal(oeeTaskPool({ split: "holdout", frozenHoldoutSha256: FROZEN_HOLDOUT_SHA256 }).length, 24);
  });

  it("reports the intended traffic-shaped bands", () => {
    assert.deepEqual(oeeTaskBands(), {
      "oee-bounded-ack": "bounded",
      "oee-bounded-route": "bounded",
      "oee-extended-chain": "extended",
      "oee-variable-fanout": "variable",
    });
    assert.deepEqual(
      Object.entries(oeeTaskBands()).reduce((counts, [slug, band]) => {
        counts[band] = (counts[band] ?? 0) + OEE_TASKS.filter((task) => task.taskId.includes(`-${slug}-`)).length;
        return counts;
      }, {}),
      { bounded: 60, extended: 24, variable: 12 },
    );
    assert.equal("canonical" in oeeSplitManifest(), false);
  });
});
