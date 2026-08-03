import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SYSTEM, parseAction, runEpisode } from "../scripts/lib/automationbench-episode.mjs";
import {
  buildReflectionBrief,
  fixtureLiteralReason,
  rotatingBatch,
  selectTrainSubset,
  trimReflectionExamples,
} from "../scripts/gepa-prompt-optimize.mjs";
import { bootstrapCI, nullFloorRows } from "../scripts/gepa-report.mjs";
import { V2_TASKS, v2TaskBands } from "../dist/automationbench-v2.js";

describe("GEPA episode helpers", () => {
  it("round-trips strict tool actions and finish", () => {
    assert.deepEqual(
      parseAction('{"tool":"api_search","arguments":{"query":"crm contacts"}}'),
      { action: { name: "api_search", arguments: { query: "crm contacts" } } },
    );
    assert.deepEqual(parseAction("<think>scratch</think>{\"tool\":\"finish\",\"arguments\":{}}"), { finish: true });
    assert.match(parseAction("not json").error, /no JSON object/);
  });

  it("adds non-grader natural-language feedback to episode rows", async () => {
    const task = V2_TASKS.find((candidate) => candidate.split === "dev");
    const row = await runEpisode({
      task,
      systemPrompt: DEFAULT_SYSTEM,
      maxTurns: 2,
      malformedTolerance: 1,
      band: "cross-record",
      chat: async () => ({ text: "not json", promptTokens: 1, completionTokens: 1 }),
    });
    assert.equal(row.score, 0);
    assert.match(row.feedback, /score 0/);
    assert.match(row.feedback, /malformed\/rejection count 1/);
    assert.match(row.feedback, /steps used of 2/);
    assert.doesNotMatch(row.feedback, /assertions|oracle|allowedWrites|initialState/);
  });

  it("selects a deterministic round-robin train subset by band", () => {
    const bands = v2TaskBands();
    const first = selectTrainSubset(V2_TASKS, bands, 12).map((task) => task.taskId);
    const second = selectTrainSubset(V2_TASKS, bands, 12).map((task) => task.taskId);
    assert.deepEqual(first, second);
    assert.equal(new Set(first).size, 12);
    assert.ok(first.every((taskId) => V2_TASKS.find((task) => task.taskId === taskId).split === "train"));
    const firstBands = first.map((taskId) => bands[V2_TASKS.find((task) => task.taskId === taskId).taskId.replace(/^(?:simple|hard)-api-/, "").replace(/-\d{2}$/, "")]);
    assert.ok(new Set(firstBands).size > 1);
  });

  it("rotates minibatches deterministically", () => {
    const tasks = [{ taskId: "a" }, { taskId: "b" }, { taskId: "c" }];
    assert.deepEqual(rotatingBatch(tasks, 0, 2), { tasks: [tasks[0], tasks[1]], nextCursor: 2 });
    assert.deepEqual(rotatingBatch(tasks, 2, 2), { tasks: [tasks[2], tasks[0]], nextCursor: 1 });
  });

  it("keeps feedback for every example but transcripts only for the worst four", () => {
    const examples = Array.from({ length: 5 }, (_unused, index) => ({
      taskId: `task-${index}`,
      feedback: `feedback-${index}`,
      score: index === 4 ? 0 : 1,
      transcript: [{ role: "assistant", content: `trace-${index}` }],
    }));
    const trimmed = trimReflectionExamples(examples, 4);
    assert.equal(trimmed.filter((example) => example.transcript.length > 0).length, 4);
    assert.equal(trimmed.find((example) => example.taskId === "task-4").feedback, "feedback-4");
    assert.equal(trimmed.find((example) => example.taskId === "task-3").transcript.length, 0);
  });

  it("keeps grader-only assertions, oracle, allowed writes, and state out of reflection briefs", () => {
    const brief = buildReflectionBrief({
      currentPrompt: DEFAULT_SYSTEM,
      examples: [{
        userPrompt: "Update the account owner.",
        transcript: [
          { role: "assistant", content: '{"tool":"api_search","arguments":{"query":"contacts"}}' },
          { role: "user", content: '{"contacts":[{"id":"c-1","owner":"u-2"}]}' },
        ],
        malformed: 1,
        forbiddenEffects: 0,
        score: 0.5,
      }],
    });
    assert.match(brief, /Update the account owner/);
    assert.match(brief, /Malformed\/rejection count: 1/);
    assert.doesNotMatch(brief, /assertions|allowedWrites|oracle|initialState/);
    assert.doesNotMatch(brief, /task_id/);
  });

  it("rejects fixture literals proposed by reflection", () => {
    const context = {
      taskIds: ["hard-api-ticket-owner-route-01"],
      transcript: [{ role: "user", content: '{"id":"c-1","email":"person@example.test"}' }],
    };
    assert.match(fixtureLiteralReason("Write to person@example.test", context), /@ token/);
    assert.match(fixtureLiteralReason("Use c-1", context), /record id/);
    assert.match(fixtureLiteralReason("hard-api-ticket-owner-route-01", context), /task id/);
    assert.equal(fixtureLiteralReason("Always inspect before writing.", context), null);
  });

  it("keeps bootstrap confidence intervals deterministic", () => {
    assert.deepEqual(
      bootstrapCI([0, 0.5, 1], { resamples: 100, seed: 17 }),
      bootstrapCI([0, 0.5, 1], { resamples: 100, seed: 17 }),
    );
  });

  it("computes a deterministic do-nothing null floor without model calls", () => {
    const rows = nullFloorRows("dev");
    assert.equal(rows.length, 36);
    assert.ok(rows.every((row) => row.score === 0 && row.steps === 0 && row.tool_calls === 0));
  });
});
