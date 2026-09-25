import assert from "node:assert/strict";
import test from "node:test";
import { buildRolloutReview, readJsonPointer, summarizeNumbers } from "../dist/rollout-review.js";

const selectors = { taskId: "/metadata/execution", userId: "/metadata/user", environment: "/metadata/environment" };
function capture(id, task = "task-before", options = {}) {
  const side = options.side ?? "before";
  return { capture: { request_id: id, org_id: "synthetic-org", project_id: "synthetic-project", workload_id: side === "before" ? "workload-before" : "workload-after",
    ts: side === "before" ? "2026-01-01T12:00:00Z" : "2026-01-02T12:00:00Z", status_code: 200,
    requested_model: "synthetic-requested", metadata: { execution: task, user: "synthetic-user", environment: "production" },
    customer_request_body: { model: "synthetic-requested", messages: [{ role: "user", content: "Synthetic task prose never copied into report." }] },
    response_body: { model: "synthetic-observed", choices: [{ message: { role: "assistant", content: "Synthetic completion never copied." }, finish_reason: "stop" }] },
    ...options.envelope }, source: options.source ?? { path: `sources/${id}.json`, sha256: "a".repeat(64) } };
}
function input(before = [], after = [], extra = {}) {
  return { before: { captures: before, workload: "workload-before", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
    after: { captures: after, workload: "workload-after", from: "2026-01-02T00:00:00Z", to: "2026-01-03T00:00:00Z" }, selectors, ...extra };
}

test("explicit tasks account for all requests and compare exact user/environment cells", () => {
  const a = capture("a"), b = capture("b", "task-before", { envelope: { ts: "2026-01-01T12:00:01Z" } });
  const c = capture("c", "task-after", { side: "after" });
  const report = buildRolloutReview(input([a, b], [c]));
  assert.deepEqual(report.tasks.map(task => task.requestCount), [2, 1]);
  assert.equal(report.comparableGroups[0].status, "comparable");
  assert.equal(report.comparableGroups[0].before.requestsPerTask.mean, 2);
  assert.equal(report.comparableGroups[0].after.observedTerminalTasks, 1);
  assert.equal(report.accounting.reconciled, true);
  assert.equal(report.accounting.inputRecords, 3);
  assert.equal(report.accounting.groupedRecords, 3);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic task prose|Synthetic completion/);
});

test("shared trace and prompt never substitute for explicit task identity", () => {
  const a = capture("a", null), b = capture("b", null);
  a.capture.trace_id = b.capture.trace_id = "a".repeat(32);
  const report = buildRolloutReview(input([a, b]));
  assert.equal(report.tasks.length, 0); assert.equal(report.ungrouped.length, 2);
  assert.equal(report.comparableGroups.length, 0);
  assert.ok(report.ungrouped.every(row => row.reasons.includes("missing_or_invalid_task_id")));
});

test("identity collisions and any missing member selector quarantine the whole explicit task", () => {
  for (const key of ["user", "environment"]) {
    const a = capture("a"), b = capture("b");
    b.capture.metadata[key] = "different";
    const report = buildRolloutReview(input([a, b]));
    assert.equal(report.tasks.length, 0); assert.equal(report.ungrouped.length, 2);
    assert.ok(report.ungrouped[0].reasons.some(reason => reason.includes("collision")));
    delete b.capture.metadata[key];
    assert.equal(buildRolloutReview(input([a, b])).tasks.length, 0);
  }
});

test("unknown identities do not form comparison cells and org/project changes remain separate", () => {
  const after = capture("after", "after-task", { side: "after", envelope: { org_id: "different-org" } });
  const report = buildRolloutReview(input([capture("before")], [after]));
  assert.equal(report.comparableGroups.length, 2);
  assert.ok(report.comparableGroups.every(group => group.status !== "comparable"));
  after.capture.metadata.user = null;
  assert.equal(buildRolloutReview(input([], [after])).comparableGroups.length, 0);
});

test("exact duplicates retain ledger entries; conflicting request copies cannot fragment a task", () => {
  const a = capture("a"), copy = structuredClone(a);
  let report = buildRolloutReview(input([a, copy]));
  assert.equal(report.tasks[0].requestCount, 1); assert.equal(report.accounting.duplicateRecords, 1);
  copy.capture.status_code = 500;
  report = buildRolloutReview(input([a, copy, capture("b")]));
  assert.equal(report.tasks.length, 0); assert.equal(report.accounting.ungroupedRecords, 3);
  assert.ok(report.ungrouped.some(row => row.reasons.includes("conflicting_request_in_task")));
});

test("whole explicit tasks cross windows visibly; missing terminal stays in observed metrics", () => {
  const a = capture("a"), b = capture("b", "task-before", { envelope: { ts: "2026-01-02T00:00:01Z" } });
  let report = buildRolloutReview(input([a, b]));
  assert.equal(report.tasks[0].requestCount, 2); assert.ok(report.tasks[0].flags.includes("crosses_declared_window"));
  assert.equal(report.tasks[0].comparisonEligible, false);
  assert.equal(report.comparableGroups.length, 0);
  a.capture.response_body = { model: "synthetic-observed", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] };
  report = buildRolloutReview(input([a]));
  assert.equal(report.comparableGroups[0].before.tasks, 1);
  assert.equal(report.comparableGroups[0].before.observedTerminalTasks, 0);
  assert.equal(report.comparableGroups[0].before.censoredTasks, 1);
});

test("source request start controls membership; invalid timestamps never silently disappear", () => {
  const a = capture("a", "task-before", { envelope: { ts: "2026-01-02T00:00:01Z" }, source: { request_started_at: "2026-01-01T23:59:59Z" } });
  const b = capture("b", "other", { envelope: { ts: "invalid" } });
  const report = buildRolloutReview(input([a, b]));
  assert.equal(report.tasks.length, 1); assert.equal(report.ungrouped.length, 1);
  assert.equal(report.requests[0].timestampSource, "source.request_started_at");
  assert.equal(report.accounting.reconciled, true);
});

test("requested and failed-response models are never claimed as observed served models", () => {
  const a = capture("a", "a", { envelope: { status_code: 502 } });
  const b = capture("b", "b", { envelope: { response_body: null, upstream_model: "configured-only" } });
  const report = buildRolloutReview(input([a, b]));
  assert.ok(report.requests.every(row => row.observedModel === null));
  assert.equal(report.requests[0].observedTerminal, false);
  assert.equal(report.requests[0].httpError, true);
});

test("RFC6901 selectors decode nested body strings without inherited-property access", () => {
  assert.equal(readJsonPointer({ "a/b": { "~key": 0 } }, "/a~1b/~0key").value, 0);
  assert.equal(readJsonPointer({}, "/toString").status, "missing");
  assert.equal(readJsonPointer({}, "/bad~2token").status, "invalid");
  const row = capture("nested");
  delete row.capture.customer_request_body; delete row.capture.response_body; delete row.capture.status_code;
  row.capture.request = { body: JSON.stringify({ metadata: { execution: "nested-task", user: "synthetic-user", environment: "production" }, messages: [{ role: "user", content: "synthetic" }] }) };
  row.capture.response = { status: 200, body: JSON.stringify({ model: "synthetic", choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }) };
  const report = buildRolloutReview(input([row], [], { selectors: { taskId: "/request/body/metadata/execution", userId: "/request/body/metadata/user", environment: "/request/body/metadata/environment" } }));
  assert.equal(report.tasks[0].taskId, "nested-task"); assert.equal(report.requests[0].statusCode, 200); assert.equal(report.requests[0].observedTerminal, true);
});

test("Chat and Anthropic streaming use explicit finish evidence; malformed/truncated streams stay open", () => {
  const chat = [
    'data: {"model":"synthetic-stream","choices":[{"index":0,"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}', "data: [DONE]"].join("\n\n");
  const anthropic = [
    'data: {"type":"message_start","message":{"model":"synthetic-anthropic"}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'data: {"type":"message_stop"}'].join("\n\n");
  const rows = [capture("chat", "chat", { envelope: { response_body: chat } }), capture("anthropic", "anthropic", { envelope: { response_body: anthropic } }),
    capture("bad", "bad", { envelope: { response_body: "data: {bad\n" + chat } }),
    capture("partial", "partial", { envelope: { response_body: chat.split("\n\n")[0] } })];
  const report = buildRolloutReview(input(rows));
  assert.deepEqual(report.requests.map(row => row.observedTerminal), [true, true, false, false]);
  assert.equal(report.requests[0].observedModel, "synthetic-stream");
  assert.equal(report.requests[1].observedModel, "synthetic-anthropic");
  assert.ok(report.requests[2].flags.includes("malformed_stream_records"));
});

test("streamed tool-call deltas are assembled but are not terminal outcomes", () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"synthetic-tool","arguments":"{\\"x\\":"}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}', "data: [DONE]"].join("\n\n");
  const report = buildRolloutReview(input([capture("stream", "stream", { envelope: { response_body: stream } })]));
  assert.equal(report.requests[0].observedTerminal, false);
  assert.equal(report.requests[0].toolEvents.length, 1);
  assert.equal(report.requests[0].toolEvents[0].name, "synthetic-tool");
  assert.equal(report.requests[0].format, "chat_completions_stream");
});

test("Responses API JSON supports function results and completed messages; unknown stream stays visible", () => {
  const row = capture("responses", "responses", { envelope: { customer_request_body: { input: [{ type: "function_call_output", call_id: "call-1", output: JSON.stringify({ success: false, validationErrors: [{ message: "synthetic required" }] }) }] },
    response_body: { model: "synthetic", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] } } });
  const report = buildRolloutReview(input([row, capture("unknown", "unknown", { envelope: { response_body: 'data: {"type":"response.completed","response":{"status":"completed"}}' } })]));
  assert.equal(report.requests[0].format, "responses"); assert.equal(report.requests[0].observedTerminal, true);
  assert.equal(report.tasks[0].argumentValidationErrors, 1);
  assert.equal(report.requests[1].format, "unsupported_stream"); assert.equal(report.requests[1].observedTerminal, false);
});

test("native validation requires a structured error and nonempty details; cumulative history is deduped by occurrence", () => {
  const user = { role: "user", content: "synthetic" };
  const call = { role: "assistant", tool_calls: [{ id: "counter_0", function: { name: "synthetic-tool", arguments: "{}" } }] };
  const result = { role: "tool", tool_call_id: "counter_0", content: JSON.stringify({ success: false, validationErrors: [{ message: "required" }] }) };
  const a = capture("a", "same", { envelope: { customer_request_body: { messages: [user, call, result] } } });
  const b = capture("b", "same", { envelope: { ts: "2026-01-01T12:00:01Z", customer_request_body: { messages: [user, call, result, call, result] } } });
  const report = buildRolloutReview(input([a, b]));
  assert.equal(report.tasks[0].nativeToolErrors, 2, "same result at two distinct historical occurrences is retained");
  assert.equal(report.tasks[0].argumentValidationErrors, 2);
  b.capture.customer_request_body.messages = [user, { ...result, content: JSON.stringify({ success: false, validationErrors: [] }) }];
  const empty = buildRolloutReview(input([b]));
  assert.equal(empty.tasks[0].nativeToolErrors, 1); assert.equal(empty.tasks[0].argumentValidationErrors, 0);
  b.capture.customer_request_body.messages = [user, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: JSON.stringify({ success: false, validationErrors: [{ message: "required" }] }) }] }] }];
  assert.equal(buildRolloutReview(input([b])).tasks[0].argumentValidationErrors, 1);
});

test("native MCP isError signals are observed without guessing validation from text", () => {
  const row = capture("mcp", "mcp", { envelope: { customer_request_body: { messages: [
    { role: "user", content: "synthetic task" },
    { role: "tool", tool_call_id: "mcp-call", content: JSON.stringify({ isError: true, content: [{ type: "text", text: "Invalid arguments" }] }) },
  ] } } });
  const report = buildRolloutReview(input([row]));
  assert.equal(report.tasks[0].nativeToolErrors, 1);
  assert.equal(report.comparableGroups[0].before.nativeToolErrorTasks, 1);
  assert.equal(report.tasks[0].argumentValidationErrors, 0, "free text does not prove argument-validation classification");
  row.capture.customer_request_body.messages[1].content = JSON.stringify({ isError: false, content: [{ type: "text", text: "Invalid arguments" }] });
  assert.equal(buildRolloutReview(input([row])).tasks[0].nativeToolErrors, 0);
});

test("durations require explicit pointer and basis; partial sums never masquerade as complete or elapsed", () => {
  const a = capture("a", "a", { envelope: { duration: 100, latency_ms: 9999 } }), b = capture("b", "a", { envelope: { ts: "2026-01-01T12:00:01Z" } });
  assert.equal(buildRolloutReview(input([a])).requests[0].durationMs, null);
  assert.throws(() => buildRolloutReview(input([a], [], { selectors: { ...selectors, durationMs: "/duration" } })), /durationBasis/);
  const report = buildRolloutReview(input([a, b], [], { selectors: { ...selectors, durationMs: "/duration" }, durationBasis: "Synthetic full model response duration" }));
  assert.equal(report.tasks[0].durationSumMs, null); assert.equal(report.tasks[0].observedDurationSumMs, 100);
  assert.equal(report.comparableGroups[0].before.requestDurationSumMs.n, 0);
  assert.equal(report.comparableGroups[0].before.topSlowRequests[0].durationMs, 100);
  assert.deepEqual(summarizeNumbers([1, 2, 3, 100]), { n: 4, mean: 26.5, median: 2.5, p90: 100, min: 1, max: 100 });
});

test("cross-side identities, scope mismatch, mixed models and sensitive source paths are explicit", () => {
  const a = capture("a", "same", { source: { path: "/private/synthetic/capture.json", sha256: "a".repeat(64) } });
  const b = capture("b", "same", { side: "after" });
  let report = buildRolloutReview(input([a], [b]));
  assert.ok(report.tasks.every(task => !task.comparisonEligible)); assert.equal(report.comparableGroups.length, 0);
  assert.equal(report.requests[0].source.path, undefined);
  const c = capture("c", "same", { envelope: { ts: "2026-01-01T12:00:01Z", response_body: { model: "other-observed", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] } } });
  report = buildRolloutReview(input([a, c]));
  assert.ok(report.tasks[0].flags.includes("mixed_observed_models"));
  report = buildRolloutReview(input([a], [], { scope: { orgId: "other-org" } }));
  assert.equal(report.accounting.excludedRecords, 1);
  assert.ok(report.requests[0].reasons.includes("declared_scope_mismatch"));
});

test("pooled metrics retain duration coverage and outliers across cohorts without treating partial sums as complete", () => {
  const completeA = capture("complete-a", "complete-a", { envelope: { duration: 100 } });
  const completeB = capture("complete-b", "complete-b", { envelope: { duration: 300 } });
  const partialA = capture("partial-a", "partial", { envelope: { duration: 900, metadata: { execution: "partial", user: "synthetic-second-user", environment: "production" } } });
  const partialB = capture("partial-b", "partial", { envelope: { ts: "2026-01-01T12:00:01Z", metadata: { ...partialA.capture.metadata } } });
  const boundaryA = capture("boundary-a", "boundary", { envelope: { duration: 9999 } });
  const boundaryB = capture("boundary-b", "boundary", { envelope: { duration: 9999, ts: "2026-01-02T00:00:01Z" } });
  const ungrouped = capture("ungrouped", null, { envelope: { duration: 99999 } });
  const report = buildRolloutReview(input([completeA, completeB, partialA, partialB, boundaryA, boundaryB, ungrouped], [], {
    selectors: { ...selectors, durationMs: "/duration" }, durationBasis: "Synthetic request measurement",
  }));
  assert.equal(report.comparableGroups.length, 2);
  const pooled = report.pooledMetrics.before;
  assert.equal(pooled.tasks, 3);
  assert.equal(pooled.requests, 4);
  assert.equal(pooled.requestsPerTask.mean, 4 / 3);
  assert.deepEqual(pooled.requestDurationSumMs, { n: 2, mean: 200, median: 200, p90: 300, min: 100, max: 300 });
  assert.deepEqual(pooled.requestDurationMs, { n: 3, mean: 1300 / 3, median: 300, p90: 900, min: 100, max: 900 });
  assert.equal(pooled.missingDurationRequests, 1);
  assert.deepEqual(pooled.topSlowRequests.map(row => row.requestId), ["partial-a", "complete-b", "complete-a"]);
  assert.equal(pooled.maxDropSensitivity.requestsPerTask.mean, 1);
  assert.equal(pooled.maxDropSensitivity.requestDurationSumMs.mean, 100);
  assert.equal(report.pooledMetrics.after, null);

  const noDurations = buildRolloutReview(input([capture("missing", "missing")]));
  assert.equal(noDurations.pooledMetrics.before.requestDurationSumMs.median, null);
  assert.equal(noDurations.pooledMetrics.before.missingDurationRequests, 1);
  assert.deepEqual(noDurations.pooledMetrics.before.topSlowRequests, []);
});
