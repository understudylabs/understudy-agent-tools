import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  extractJsonObject,
  scoreObject,
  summarizeEvents,
} from "../experiments/desktop-grocery-proof/run.mjs";
import {
  buildBuyerReport,
  buildReportModel,
  verdictProbabilityEvidence,
} from "../experiments/desktop-grocery-proof/report.mjs";

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

  it("replaces a rejected completed answer while retaining role evidence", () => {
    const events = [
      { event: "delta", data: { role: "student", text: '{"answer":"wrong"}' } },
      { event: "student_interruption", data: { partial_text: '{"answer":"wrong"}' } },
      { event: "teacher_continuation", data: { output_mode: "replace" } },
      { event: "delta", data: { role: "teacher", text: '{"answer":"correct"}' } },
    ];
    const summary = summarizeEvents(events, 42);
    assert.equal(summary.output, '{"answer":"correct"}');
    assert.deepEqual(summary.output_by_role, {
      student: '{"answer":"wrong"}',
      teacher: '{"answer":"correct"}',
    });
  });

  it("labels logprobs honestly and derives bounded first-token probabilities", () => {
    const explicit = verdictProbabilityEvidence({
      verdict: "interrupt",
      probability_kind: "logprob",
      probabilities: { interrupt: -0.0704345703125, continue: -5.223102569580078 },
    });
    assert.equal(explicit.source_probability_kind, "logprob");
    assert.equal(explicit.probability_kind, "first_token_probability_from_logprob");
    assert.equal(explicit.inferred_source_kind, false);
    assert.ok(explicit.chosen_probability > 0.93 && explicit.chosen_probability < 0.94);
    assert.ok(Object.values(explicit.probabilities).every((value) => value >= 0 && value <= 1));

    const legacy = verdictProbabilityEvidence({
      verdict: "continue",
      probabilities: { continue: -0.0034, stop: -6.1 },
    });
    assert.equal(legacy.source_probability_kind, "logprob");
    assert.equal(legacy.inferred_source_kind, true);
    assert.ok(legacy.chosen_probability > 0.99);
  });

  it("turns exact route evidence into bounded buyer recommendations", () => {
    const tasks = [
      { id: "code", title: "Code review", prompt: "private prompt" },
      { id: "cart", title: "Cart substitution", prompt: "private prompt" },
      { id: "ops", title: "Ops classification", prompt: "private prompt" },
    ];
    const outcome = {
      code: { small: false, main: true, supervised: false, missed: true },
      cart: { small: false, main: true, supervised: true, corrected: true },
      ops: { small: true, main: true, supervised: true },
    };
    const rows = tasks.flatMap((task) => ["small", "main", "supervised"].map((mode) => ({
      proof_id: "proof-1",
      suite_sha256: "a".repeat(64),
      task_id: task.id,
      task_title: task.title,
      mode,
      score: { exact: outcome[task.id][mode], field_accuracy: outcome[task.id][mode] ? 1 : 2 / 3 },
      supervisor_correct_intervention: mode === "supervised" && Boolean(outcome[task.id].corrected),
      supervisor_missed_error: mode === "supervised" && Boolean(outcome[task.id].missed),
      student_score: mode === "supervised"
        ? { exact: outcome[task.id].small, field_accuracy: outcome[task.id].small ? 1 : 2 / 3 }
        : null,
      verdicts: mode === "supervised" ? [{
        verdict: outcome[task.id].corrected ? "interrupt" : "continue",
        reason: outcome[task.id].corrected ? "The student selected the wrong constraint result." : null,
        marker_id: `marker-${task.id}`,
        probability_kind: "logprob",
        probabilities: outcome[task.id].corrected
          ? { interrupt: -0.01, continue: -5 }
          : { continue: -0.01, interrupt: -5 },
      }] : [],
    })));
    const summary = {
      proof_id: "proof-1",
      suite_sha256: "a".repeat(64),
      completed_at: "2026-07-12T00:00:00Z",
      task_count: 3,
      run_count: 9,
      by_mode: {
        small: { exact_passes: 1, task_count: 3, mean_field_accuracy: 7 / 9, mean_latency_ms: 1700, total_tokens: 3000, latency_reduction_vs_main: 0.25 },
        main: { exact_passes: 3, task_count: 3, mean_field_accuracy: 1, mean_latency_ms: 2300, total_tokens: 4000 },
        supervised: { exact_passes: 2, task_count: 3, mean_field_accuracy: 8 / 9, mean_latency_ms: 2800, total_tokens: 4800, latency_reduction_vs_main: -0.2, supervisor_verdicts: 3, interventions: 1, supervisor_correct_interventions: 1, supervisor_missed_errors: 1, supervisor_false_positives: 0, mean_small_model_output_share: 0.85, mean_supervisor_token_overhead: 0.43 },
      },
    };
    const model = buildReportModel(summary, rows, tasks);
    assert.deepEqual(model.decisions.map(({ state }) => state), ["hold", "supervise", "pilot"]);
    assert.match(model.recommendation, /pilot the smaller model on Ops classification/i);
    assert.match(model.recommendation, /keep Code review on the main model/i);
    assert.deepEqual(
      model.supervision.judgments.map(({ outcome: judgmentOutcome }) => judgmentOutcome),
      ["missed error", "correct intervention", "correct continue"],
    );
    assert.ok(model.supervision.judgments.every(
      (judgment) => judgment.chosen_probability > 0.98,
    ));

    const html = buildBuyerReport(summary, rows, tasks);
    assert.match(html, /<h2 id="executive-summary">Executive Summary<\/h2>/);
    assert.match(html, /The supervisor helped once and missed once/);
    assert.match(html, /chosen-verdict first-token probability/);
    assert.match(html, /The student selected the wrong constraint result/);
    assert.doesNotMatch(html, /private prompt/);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it("escapes task labels in the portable report", () => {
    const tasks = [{ id: "x", title: "<script>alert(1)</script>" }];
    const rows = ["small", "main", "supervised"].map((mode) => ({
      proof_id: "proof-x",
      suite_sha256: "b".repeat(64),
      task_id: "x",
      mode,
      score: { exact: true, field_accuracy: 1 },
    }));
    const metric = { exact_passes: 1, task_count: 1, mean_field_accuracy: 1, mean_latency_ms: 10, total_tokens: 10 };
    const summary = {
      proof_id: "proof-x",
      suite_sha256: "b".repeat(64),
      completed_at: "2026-07-12T00:00:00Z",
      task_count: 1,
      run_count: 3,
      by_mode: {
        small: { ...metric, latency_reduction_vs_main: 0 },
        main: metric,
        supervised: { ...metric, latency_reduction_vs_main: 0, supervisor_verdicts: 1, interventions: 0, supervisor_correct_interventions: 0, supervisor_missed_errors: 0, supervisor_false_positives: 0, mean_small_model_output_share: 1, mean_supervisor_token_overhead: 0 },
      },
    };
    const html = buildBuyerReport(summary, rows, tasks);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  });

  it("prints one clean error when an existing proof cannot be rendered", () => {
    const script = join(process.cwd(), "experiments", "desktop-grocery-proof", "run.mjs");
    const result = spawnSync(process.execPath, [script, "--report-from", "/proof/does-not-exist"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});
