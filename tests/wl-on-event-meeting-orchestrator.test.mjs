import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FROZEN_HOLDOUT_SHA256,
  FROZEN_FIXTURE_SHA256,
  FROZEN_TRAIN_SHA256,
  FROZEN_DEV_SHA256,
  TASKS,
  assertionSatisfied,
  auditObservationLeakage,
  finish,
  fixtureSha256,
  getTask,
  oraclePolicy,
  parseToolCalls,
  partialCredit,
  reset,
  rollout,
  sentinelPolicy,
  splitCounts,
  splitSha256,
  step,
  taskBands,
  taskPool,
} from "../dist/workloads/on-event-meeting-orchestrator/offline.js";

const source = [
  "src/workloads/on-event-meeting-orchestrator/fixture-shapes.ts",
  "src/workloads/on-event-meeting-orchestrator/offline.ts",
].map((path) => readFileSync(path, "utf8")).join("\n");

describe("workload fixture pin", () => {
  it("contains 8 families and 96 stratified tasks", () => {
    assert.equal(TASKS.length, 96);
    assert.deepEqual(splitCounts(), { train: 48, dev: 16, holdout: 32 });
    assert.equal(Object.keys(taskBands()).length, 8);
    assert.deepEqual(
      new Set(Object.values(taskBands())),
      new Set(["single-write", "discovery", "conditional", "multi-write", "no-op-guard", "long-chain"]),
    );
    assert.match(fixtureSha256(), /^[0-9a-f]{64}$/);
    assert.equal(FROZEN_FIXTURE_SHA256, fixtureSha256());
    assert.equal(FROZEN_TRAIN_SHA256, splitSha256("train"));
    assert.equal(FROZEN_DEV_SHA256, splitSha256("dev"));
  });

  it("keeps IDs unique, split-disjoint, and reset states non-pre-satisfied", () => {
    const ids = TASKS.map((task) => task.taskId);
    assert.equal(new Set(ids).size, ids.length);
    const splitIds = ["train", "dev", "holdout"].map((split) =>
      new Set(TASKS.filter((task) => task.split === split).map((task) => task.taskId)));
    assert.equal(new Set(splitIds.flatMap((set) => [...set])).size, TASKS.length);
    for (const task of TASKS) {
      const earned = task.assertions.filter((assertion) => !assertionSatisfied(task.initialState, assertion));
      assert.ok(task.assertions.length > 0);
      assert.ok(earned.length > 0 || task.family === "meeting-no-op-guard", task.taskId);
      assert.equal(partialCredit(reset(task.taskId).handle), 0, task.taskId);
    }
  });
});

describe("oracle and over-acting gates", () => {
  it("scores the oracle exactly 1 with no forbidden effects", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, oraclePolicy(task.taskId));
      assert.equal(result.reward, 1, task.taskId);
      assert.deepEqual(result.forbiddenEffects, [], task.taskId);
      assert.deepEqual(result.leakage, [], task.taskId);
    }
  });

  it("scores the sentinel exactly 0 on every task", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, sentinelPolicy());
      assert.equal(result.reward, 0, task.taskId);
      assert.ok(result.forbiddenEffects.length > 0, task.taskId);
    }
  });

  it("scores a lazy immediate-finish policy zero on every task", () => {
    for (const task of TASKS) {
      const result = rollout(task.taskId, () => null);
      assert.equal(result.reward, 0, task.taskId);
    }
  });

  it("makes no-op and duplicate guards reject writers", () => {
    const noOp = getTask("meeting-no-op-guard-01");
    assert.equal(noOp.allowedWrites.length, 1);
    const noOpWriter = rollout(noOp.taskId, (obs) => obs.step === 0
      ? noOp.oracle[0]
      : { name: "api_fetch", arguments: { method: "POST", url: "/meetings", body: { attendee: "alex.rivera@example.test", slot: "2031-02-03 09:00 UTC", durationMin: 25 } } });
    assert.equal(noOpWriter.reward, 0);
    assert.ok(noOpWriter.forbiddenEffects.length > 0);

    const duplicate = getTask("meeting-duplicate-suppression-01");
    const writer = rollout(duplicate.taskId, (obs) => {
      if (obs.step === 0) return duplicate.oracle[0];
      if (obs.step === 1) return duplicate.oracle[1];
      return { name: "api_fetch", arguments: { method: "POST", url: "/meetings", body: { attendee: "alex.rivera@example.test", slot: "2031-02-03 09:00 UTC", durationMin: 25 } } };
    });
    assert.equal(writer.reward, 0);
    assert.ok(writer.forbiddenEffects.length > 0);
  });
});

describe("reachability and leakage", () => {
  it("keeps grader fields out of observations and exposes oracle literals to reads", () => {
    const strings = (value, output = []) => {
      if (typeof value === "string" && value.length > 2) output.push(value);
      else if (Array.isArray(value)) value.forEach((item) => strings(item, output));
      else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, output));
      return output;
    };
    for (const task of TASKS) {
      const { handle, obs } = reset(task.taskId);
      assert.deepEqual(auditObservationLeakage(obs, task), [], task.taskId);
      const visible = [obs.messages.map((message) => message.content).join("\n")];
      for (const action of task.oracle) {
        const method = String(action.arguments.method ?? "").toUpperCase();
        if (action.name === "api_search" || (action.name === "api_fetch" && method === "GET")) {
          visible.push(step(handle, action).obs.messages.at(-1)?.content ?? "");
        } else break;
      }
      const readable = visible.join("\n");
      for (const action of task.oracle) {
        if (action.name !== "api_fetch" || String(action.arguments.method ?? "").toUpperCase() === "GET") continue;
        for (const literal of strings(action.arguments.body)) {
          assert.ok(readable.includes(literal), `${task.taskId} cannot reach ${literal}`);
        }
      }
    }
  });
});

describe("determinism and holdout", () => {
  it("resets deterministically and does not mutate fixture state", () => {
    for (const task of TASKS) assert.deepEqual(reset(task.taskId), reset(task.taskId));
    const first = reset("meeting-reschedule-01");
    const second = reset("meeting-reschedule-01");
    step(first.handle, getTask("meeting-reschedule-01").oracle[2]);
    assert.deepEqual(second.handle.state, getTask("meeting-reschedule-01").initialState);
    assert.throws(() => reset(TASKS[0].taskId, 13), /pinned seed/);
  });

  it("refuses unpinned and mismatched holdout reads", () => {
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(() => taskPool({ split: "holdout", frozenHoldoutSha256: "0".repeat(64) }), /hash mismatch/);
    assert.equal(taskPool({ split: "holdout", frozenHoldoutSha256: splitSha256("holdout") }).length, 32);
    assert.equal(FROZEN_HOLDOUT_SHA256, splitSha256("holdout"));
  });
});

describe("parser and sanitization", () => {
  it("accepts recorded tool-call encodings", () => {
    assert.deepEqual(parseToolCalls({ tool_calls: [JSON.stringify({ name: "api_fetch", arguments: JSON.stringify({ method: "GET", url: "/meetings" }) })] }), [
      { name: "api_fetch", arguments: { method: "GET", url: "/meetings" } },
    ]);
    assert.throws(() => parseToolCalls({ tool_calls: [{ arguments: [] }] }));
  });

  it("contains only sanitized synthetic identities and test domains", () => {
    assert.doesNotMatch(source, /@(?!example\.test\b)[A-Za-z0-9.-]+/);
    assert.doesNotMatch(source, /\b(?:org|proj|cust|acct)_[A-Za-z0-9_-]+/i);
    assert.doesNotMatch(source, /\b(?:bearer|sk-[A-Za-z0-9]|api[_-]?key)\b/i);
    assert.doesNotMatch(source, /trace|telemetry|raw[_-]?event/i);
  });
});
