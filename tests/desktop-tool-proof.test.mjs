import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  scoreToolTrace,
  summarizeRows,
} from "../experiments/desktop-tool-proof/run.mjs";

const task = {
  tool: "list_traces",
  arguments: { limit: 1 },
  expected_output: "OK",
};

describe("desktop strict-tool proof", () => {
  it("requires one exact call, paired result, arguments, and output", () => {
    const events = [
      {
        event: "tool_call",
        data: {
          call_id: "call-1",
          name: "list_traces",
          parsed_arguments: { limit: 1 },
          parse_error: null,
        },
      },
      {
        event: "tool_result",
        data: { call_id: "call-1", name: "list_traces", ok: true },
      },
      { event: "delta", data: { text: "OK" } },
    ];
    const score = scoreToolTrace(events, task);
    assert.equal(score.strict_pass, true);
    assert.equal(score.orphan_result_count, 0);
    assert.deepEqual(score.checks, {
      exactly_one_call: true,
      exact_tool_name: true,
      exact_arguments: true,
      paired_successful_result: true,
      exact_output: true,
    });
  });

  it("rejects wrappers, malformed arguments, duplicates, and orphan results", () => {
    const score = scoreToolTrace([
      {
        event: "tool_call",
        data: {
          call_id: "call-1",
          name: "understudy_mcp_tool",
          parsed_arguments: { tool_name: "list_traces" },
          parse_error: null,
        },
      },
      { event: "tool_result", data: { call_id: "orphan", name: "list_traces", ok: true } },
      { event: "delta", data: { text: "YES" } },
    ], task);
    assert.equal(score.strict_pass, false);
    assert.equal(score.orphan_result_count, 1);
    assert.equal(score.checks.exact_tool_name, false);
    assert.equal(score.checks.exact_arguments, false);
    assert.equal(score.checks.paired_successful_result, false);
    assert.equal(score.checks.exact_output, false);
  });

  it("summarizes promotion evidence without hiding individual failures", () => {
    const common = {
      candidate: "12b",
      slot_id: 6,
      elapsed_ms: 100,
      total_tokens: 20,
      parse_error: null,
      orphan_result_count: 0,
      called_tool: "status",
      parsed_arguments: {},
      result_ok: true,
      output: "OK",
    };
    const summary = summarizeRows([
      {
        ...common,
        repetition: 1,
        task_id: "a",
        strict_pass: true,
        checks: {
          exactly_one_call: true,
          exact_tool_name: true,
          exact_arguments: true,
          paired_successful_result: true,
          exact_output: true,
        },
      },
      {
        ...common,
        repetition: 1,
        task_id: "b",
        strict_pass: false,
        checks: {
          exactly_one_call: false,
          exact_tool_name: false,
          exact_arguments: false,
          paired_successful_result: false,
          exact_output: false,
        },
      },
    ]);
    assert.equal(summary["12b"].strict_passes, 1);
    assert.equal(summary["12b"].attempts, 2);
    assert.equal(summary["12b"].strict_accuracy, 0.5);
    assert.equal(summary["12b"].failures.length, 1);
  });
});
