import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GROUNDED_CHAT_FIXTURE,
  TASKS,
  auditTask,
  duplicateTaskFailures,
  evaluateTask,
  fixtureSha256,
  nullAnswer,
  oracleAnswer,
  reset,
  scoreAnswer,
  splitCounts,
  splitSha256,
  splitsSha256,
  taskPool,
  validateFixture,
} from "../dist/grounded-chat-offline.js";

describe("grounded chat fixture pins", () => {
  it("has the requested task count and split sizes", () => {
    assert.equal(TASKS.length, 100);
    assert.deepEqual(splitCounts(), { train: 60, dev: 20, holdout: 20 });
    assert.deepEqual(
      new Set(TASKS.map((task) => task.band)),
      new Set(["lookup", "synthesis", "aggregation", "unanswerable"]),
    );
    assert.equal(new Set(TASKS.map((task) => task.taskId)).size, TASKS.length);
  });

  it("keeps split ids disjoint and matches frozen hashes", () => {
    const ids = ["train", "dev", "holdout"].map((split) =>
      new Set(taskPool({
        split,
        ...(split === "holdout" ? { frozenHoldoutSha256: splitSha256("holdout") } : {}),
      }).map((task) => task.taskId))
    );
    assert.equal([...ids[0]].some((id) => ids[1].has(id) || ids[2].has(id)), false);
    assert.equal([...ids[1]].some((id) => ids[2].has(id)), false);
    assert.equal(fixtureSha256(), GROUNDED_CHAT_FIXTURE.fixture_sha256);
    assert.equal(splitSha256("train"), GROUNDED_CHAT_FIXTURE.train_sha256);
    assert.equal(splitSha256("dev"), GROUNDED_CHAT_FIXTURE.dev_sha256);
    assert.equal(splitSha256("holdout"), GROUNDED_CHAT_FIXTURE.holdout_sha256);
    assert.equal(splitsSha256(), GROUNDED_CHAT_FIXTURE.splits_sha256);
  });
});

describe("grounded chat scoring", () => {
  it("scores the oracle at exactly 1.0 and the null agent at 0.0", () => {
    for (const task of TASKS) {
      const oracle = evaluateTask(task.taskId, oracleAnswer(task.taskId));
      assert.equal(oracle.score, 1, `${task.taskId} oracle`);
      assert.equal(oracle.fabrication, false, `${task.taskId} oracle fabrication`);
      assert.equal(evaluateTask(task.taskId, nullAnswer(task.taskId)).score, 0, `${task.taskId} null`);
    }
  });

  it("accepts semantically correct lookup, aggregation, and unanswerable phrasing", () => {
    const lookup = TASKS.find((candidate) => candidate.band === "lookup");
    const aggregation = TASKS.find((candidate) => candidate.band === "aggregation");
    const unanswerable = TASKS.find((candidate) => candidate.band === "unanswerable");
    assert.ok(lookup && aggregation && unanswerable);
    assert.equal(evaluateTask(lookup.taskId, lookup.gold.required_facts[0]).score, 1);
    const aggregationMatch = /- (\d+) open ([^ ]+) tasks; earliest due date is ([0-9-‑–]+)/i.exec(aggregation.context);
    assert.ok(aggregationMatch);
    assert.equal(
      evaluateTask(
        aggregation.taskId,
        `There are ${["zero", "one", "two", "three", "four", "five"][Number(aggregationMatch[1])] ?? aggregationMatch[1]} open ${aggregationMatch[2]} tasks, and the earliest due date is ${aggregationMatch[3]}.`,
      ).score,
      1,
    );
    assert.equal(
      evaluateTask(
        unanswerable.taskId,
        `The renewal review date for ${/for (.+?)\?/i.exec(unanswerable.question)[1]} is not provided in the context.`,
      ).score,
      1,
    );
  });

  it("zeroes fabricated and over-budget answers", () => {
    const task = TASKS.find((candidate) => candidate.band === "lookup");
    assert.ok(task);
    const fabricated = scoreAnswer(task, String(task.gold.forbidden_facts[0]));
    assert.equal(fabricated.fabrication, true);
    assert.equal(fabricated.score, 0);
    const overBudget = scoreAnswer(task, "x".repeat(task.max_answer_chars + 1));
    assert.equal(overBudget.overBudget, true);
    assert.equal(overBudget.score, 0);
  });
});

describe("grounded chat safety gates", () => {
  it("passes reachability and leakage audits", () => {
    assert.deepEqual(validateFixture(), []);
    assert.deepEqual(TASKS.flatMap(auditTask), []);
    assert.deepEqual(duplicateTaskFailures(), []);
  });

  it("rejects normalized question-and-gold duplicates across splits", () => {
    const duplicate = { ...TASKS[0], taskId: "chat-copy-001", split: "dev" };
    assert.match(
      duplicateTaskFailures([TASKS[0], duplicate]).join("\n"),
      /cross-split near-duplicate/,
    );
  });

  it("refuses holdout loading without the exact frozen hash", () => {
    assert.throws(() => taskPool({ split: "holdout" }), /frozen-holdout refusal/);
    assert.throws(
      () => taskPool({ split: "holdout", frozenHoldoutSha256: "wrong" }),
      /frozen-holdout refusal/,
    );
    assert.equal(taskPool({
      split: "holdout",
      frozenHoldoutSha256: splitSha256("holdout"),
    }).length, 20);
  });

  it("resets deterministically and refuses an unpinned seed", () => {
    for (const task of TASKS) {
      assert.deepEqual(reset(task.taskId), reset(task.taskId));
    }
    assert.throws(() => reset(TASKS[0].taskId, 8), /not the pinned seed/);
  });
});
