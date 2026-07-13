import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  directToolDefinitions,
  resolveDirectCandidates,
  scoreToolTrace,
  selectTasks,
  summarizeRows,
} from "../experiments/desktop-tool-proof/run.mjs";

const task = {
  tool: "list_traces",
  arguments: { limit: 1 },
  expected_output: "OK",
};

describe("desktop strict-tool proof", () => {
  it("selects an exact ordered subset for causal probes", () => {
    const tasks = [{ id: "one" }, { id: "two" }];
    assert.deepEqual(selectTasks(tasks, ["two"]), [{ id: "two" }]);
    assert.throws(() => selectTasks(tasks, ["missing"]), /unknown task-id: missing/);
    assert.throws(() => selectTasks(tasks, ["one", "one"]), /must be unique/);
    assert.throws(() => selectTasks(tasks, ["missing", "missing"]), /must be unique/);
  });

  it("builds the bounded direct tool set from the authenticated MCP contract", () => {
    const names = [
      "status",
      "residency",
      "list_models",
      "list_snapshot_models",
      "list_traces",
      "search_traces",
      "open_trace",
    ];
    const tools = directToolDefinitions(names.map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: "object", properties: {} },
    })));
    assert.deepEqual(tools.map(({ name }) => name), [
      ...names,
      "understudy_mcp_tool",
      "understudy_agent_tools",
    ]);
    assert.throws(
      () => directToolDefinitions([]),
      /missing required direct-proof tool: status/,
    );
  });

  it("resolves only running slots with an attested local model path", () => {
    const targets = resolveDirectCandidates(
      [{ label: "12b", slotId: 6 }],
      {
        slots: [{
          id: 6,
          state: "running",
          port: 8095,
          model_id: "gemma-4-12b-it-qat-mlx-vlm-understudy",
        }],
      },
      {
        app: {
          warm_models: [{
            id: "gemma-4-12b-it-qat-mlx-vlm-understudy",
            port: 8095,
            model_path: "/models/12b",
          }],
        },
      },
    );
    assert.deepEqual(targets, [{
      label: "12b",
      slotId: 6,
      modelId: "gemma-4-12b-it-qat-mlx-vlm-understudy",
      modelPath: "/models/12b",
      baseUrl: "http://127.0.0.1:8095/v1",
    }]);
    assert.throws(
      () => resolveDirectCandidates(
        [{ label: "12b", slotId: 6 }],
        { slots: [{ id: 6, state: "stopped", port: 8095 }] },
        { app: { warm_models: [] } },
      ),
      /slot 6 is not warm/,
    );
  });

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
      terminal_error_free: true,
      exact_call_count: true,
      exact_tool_sequence: true,
      exact_arguments: true,
      paired_successful_results: true,
      no_orphan_results: true,
      exact_output: true,
    });
  });

  it("scores intentional no-tool abstention as a strict behavior", () => {
    const score = scoreToolTrace(
      [{ event: "delta", data: { text: "NO_TOOL" } }],
      { calls: [], expected_output: "NO_TOOL" },
    );
    assert.equal(score.strict_pass, true);
    assert.equal(score.call_count, 0);
    assert.equal(score.checks.exact_call_count, true);
    assert.equal(score.checks.paired_successful_results, true);
  });

  it("does not inflate component rates when abstention makes an unwanted call", () => {
    const score = scoreToolTrace(
      [{
        event: "tool_call",
        data: { call_id: "unexpected", name: "status", parsed_arguments: {}, parse_error: null },
      }],
      { calls: [], expected_output: "NO_TOOL" },
    );
    assert.equal(score.strict_pass, false);
    assert.equal(score.checks.exact_call_count, false);
    assert.equal(score.checks.exact_tool_sequence, false);
    assert.equal(score.checks.exact_arguments, false);
  });

  it("requires multi-step calls, arguments, and results in the frozen order", () => {
    const multiTask = {
      calls: [
        { tool: "status", arguments: {} },
        { tool: "residency", arguments: {} },
      ],
      expected_output: "OK",
    };
    const events = [
      { event: "tool_call", data: { call_id: "one", name: "status", parsed_arguments: {}, parse_error: null } },
      { event: "tool_result", data: { call_id: "one", name: "status", ok: true } },
      { event: "tool_call", data: { call_id: "two", name: "residency", parsed_arguments: {}, parse_error: null } },
      { event: "tool_result", data: { call_id: "two", name: "residency", ok: true } },
      { event: "delta", data: { text: "OK" } },
    ];
    assert.equal(scoreToolTrace(events, multiTask).strict_pass, true);
    const reversed = structuredClone(events);
    reversed[0].data.name = "residency";
    reversed[1].data.name = "residency";
    reversed[2].data.name = "status";
    reversed[3].data.name = "status";
    const score = scoreToolTrace(reversed, multiTask);
    assert.equal(score.strict_pass, false);
    assert.equal(score.checks.exact_call_count, true);
    assert.equal(score.checks.exact_tool_sequence, false);
  });

  it("rejects punctuation-suffixed tool names instead of normalizing execution", () => {
    const score = scoreToolTrace([
      {
        event: "tool_call",
        data: {
          call_id: "one",
          name: "list_snapshot_models:",
          parsed_arguments: {},
          parse_error: null,
        },
      },
      {
        event: "tool_result",
        data: { call_id: "one", name: "list_snapshot_models:", ok: false },
      },
      { event: "delta", data: { text: "OK" } },
    ], {
      calls: [{ tool: "list_snapshot_models", arguments: {} }],
      expected_output: "OK",
    });
    assert.equal(score.strict_pass, false);
    assert.equal(score.checks.exact_call_count, true);
    assert.equal(score.checks.exact_tool_sequence, false);
    assert.equal(score.checks.exact_arguments, true);
    assert.equal(score.checks.paired_successful_results, false);
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
    assert.equal(score.checks.exact_tool_sequence, false);
    assert.equal(score.checks.exact_arguments, false);
    assert.equal(score.checks.paired_successful_results, false);
    assert.equal(score.checks.no_orphan_results, false);
    assert.equal(score.checks.exact_output, false);
  });

  it("separates terminal runtime errors from model tool-call mistakes", () => {
    const score = scoreToolTrace([{
      event: "error",
      data: { message: "provider rejected the configured model field" },
    }], task);
    assert.equal(score.strict_pass, false);
    assert.equal(score.checks.terminal_error_free, false);
    assert.equal(score.terminal_error, "provider rejected the configured model field");
  });

  it("summarizes promotion evidence without hiding individual failures", () => {
    const common = {
      candidate: "12b",
      slot_id: 6,
      elapsed_ms: 100,
      total_tokens: 20,
      parse_error: null,
      parse_error_count: 0,
      orphan_result_count: 0,
      called_tool: "status",
      parsed_arguments: {},
      call_sequence: [{ tool: "status", arguments: {}, parse_error: null }],
      result_ok: true,
      terminal_error: null,
      output: "OK",
    };
    const summary = summarizeRows([
      {
        ...common,
        repetition: 1,
        task_id: "a",
        strict_pass: true,
        checks: {
          terminal_error_free: true,
          exact_call_count: true,
          exact_tool_sequence: true,
          exact_arguments: true,
          paired_successful_results: true,
          no_orphan_results: true,
          exact_output: true,
        },
      },
      {
        ...common,
        repetition: 1,
        task_id: "b",
        strict_pass: false,
        checks: {
          terminal_error_free: true,
          exact_call_count: false,
          exact_tool_sequence: false,
          exact_arguments: false,
          paired_successful_results: false,
          no_orphan_results: true,
          exact_output: false,
        },
      },
    ]);
    assert.equal(summary["12b"].strict_passes, 1);
    assert.equal(summary["12b"].attempts, 2);
    assert.equal(summary["12b"].strict_accuracy, 0.5);
    assert.equal(summary["12b"].exact_call_count_rate, 0.5);
    assert.equal(summary["12b"].terminal_errors, 0);
    assert.equal(summary["12b"].failures.length, 1);
  });
});
