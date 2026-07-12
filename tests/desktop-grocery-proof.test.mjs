import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractJsonObject,
  scoreObject,
  summarizeEvents,
} from "../experiments/desktop-grocery-proof/run.mjs";

describe("desktop grocery proof", () => {
  it("extracts bounded JSON and scores exact fields without an LLM judge", () => {
    const expected = { bug: "lost_update", fix: "atomic_conditional_decrement" };
    const actual = extractJsonObject(`answer: {"bug":"lost_update","fix":"atomic_conditional_decrement"}`);
    assert.deepEqual(actual, expected);
    assert.deepEqual(scoreObject(actual, expected), {
      exact: true,
      matched_fields: 2,
      total_fields: 2,
      field_accuracy: 1,
    });
    assert.equal(scoreObject({ bug: "none" }, expected).field_accuracy, 0);
  });

  it("attributes student, supervisor, and teacher usage independently", () => {
    const events = [
      { event: "delta", data: { role: "student", text: "wrong" } },
      { event: "usage", data: { role: "student", input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
      { event: "supervisor_verdict", data: { verdict: "interrupt" } },
      { event: "usage", data: { role: "supervisor", input_tokens: 8, output_tokens: 1, total_tokens: 9 } },
      { event: "student_interruption", data: { partial_text: "wrong" } },
      { event: "teacher_continuation", data: {} },
      { event: "delta", data: { role: "teacher", text: " corrected" } },
      { event: "usage", data: { role: "teacher", input_tokens: 12, output_tokens: 2, total_tokens: 14 } },
    ];
    const summary = summarizeEvents(events, 42);
    assert.equal(summary.output, "wrong corrected");
    assert.deepEqual(summary.output_by_role, { student: "wrong", teacher: " corrected" });
    assert.equal(summary.usage.student.total_tokens, 12);
    assert.equal(summary.usage.supervisor.total_tokens, 9);
    assert.equal(summary.usage.teacher.total_tokens, 14);
    assert.equal(summary.student_interruptions, 1);
    assert.equal(summary.teacher_continuations, 1);
    assert.equal(summary.small_model_output_share, 0.5);
    assert.equal(summary.supervisor_token_overhead, 9 / 26);
  });
});
