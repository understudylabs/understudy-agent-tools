import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderTraceViewer } from "../dist/trace-viewer.js";

function capture({ id, traceId, ts, workload = "synthetic-automation", body = "Completed" }) {
  return {
    schema_version: 4,
    request_id: id,
    trace_id: traceId,
    ts,
    workload_name: workload,
    provider: "openai",
    requested_model: "synthetic-model",
    status_code: 200,
    latency_ms: 125,
    customer_request_body: JSON.stringify({
      model: "synthetic-model",
      messages: [
        { role: "system", content: "Operate a synthetic project board." },
        { role: "user", content: "Update synthetic record 7." },
      ],
      tools: [{
        type: "function",
        function: {
          name: "update-record",
          description: "Update a synthetic record.",
          parameters: { type: "object", properties: { id: { type: "number" } } },
        },
      }],
    }),
    response_body: JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: body,
          tool_calls: [{
            id: "call-synthetic",
            type: "function",
            function: { name: "update-record", arguments: "{\"id\":7}" },
          }],
        },
      }],
    }),
  };
}

function viewerData(output) {
  const context = { window: {} };
  runInNewContext(readFileSync(join(output, "trace-data.js"), "utf8"), context);
  return context.window;
}

test("renders one selected trace with the reusable prompt and tool viewer", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-trace-viewer-"));
  const source = join(root, "captures");
  const output = join(root, ".understudy", "trace-viewer", "trace-a");
  mkdirSync(source, { recursive: true });
  const rows = [
    capture({ id: "request-2", traceId: "trace-a", ts: "2026-07-21T12:00:02Z", body: "</script><script>alert('no')</script>" }),
    capture({ id: "request-1", traceId: "trace-a", ts: "2026-07-21T12:00:01Z" }),
    capture({ id: "other", traceId: "trace-b", ts: "2026-07-21T12:00:03Z" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = renderTraceViewer(source, output, "trace-a", "Synthetic project / automation");
  assert.equal(result.trace_id, "trace-a");
  assert.deepEqual(result.counts, {
    source_files: 1,
    captures: 2,
    workloads: 1,
    invalid_timestamp_filtered: 0,
  });
  assert.equal(result.privacy.must_not_commit, true);

  const viewer = readFileSync(join(output, "index.html"), "utf8");
  assert.match(viewer, /System prompt/);
  assert.match(viewer, /Tool invocations/);
  assert.match(viewer, /TRACE_VIEWER_META/);
  assert.doesNotMatch(viewer, /"trace-a"|"request-1"|Synthetic project \/ automation/);

  const data = readFileSync(join(output, "trace-data.js"), "utf8");
  assert.match(data, /window\.TRACE_VIEWER_META/);
  assert.match(data, /Synthetic project \/ automation/);
  assert.match(data, /request-1/);
  assert.doesNotMatch(data, /"other"/);
  assert.doesNotMatch(data, /<script>/);
  assert.ok(data.indexOf("request-1") < data.indexOf("request-2"));

  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, "understudy.trace_viewer.v1");
  assert.equal(statSync(join(output, "index.html")).mode & 0o777, 0o600);
  assert.equal(statSync(join(output, "trace-data.js")).mode & 0o777, 0o600);
});

test("normalizes streamed, nested, and foundry response envelopes for display", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-trace-viewer-responses-"));
  const source = join(root, "captures.json");
  const output = join(root, ".understudy", "viewer");
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"Checking ","tool_calls":[{"index":0,"id":"call-weather","function":{"name":"lookup-weather","arguments":"{\\"city\\":\\""}}]}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"now","tool_calls":[{"index":0,"function":{"arguments":"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "data: [DONE]",
  ].join("\n\n");
  const nested = JSON.stringify(JSON.stringify({
    choices: [{ message: { role: "assistant", content: "Nested response" } }],
  }));
  const anthropicSse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic response"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-anthropic","name":"read-record","input":{}}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"7}"}}',
  ].join("\n\n");
  const foundry = {
    encoding: "json",
    body: { content: [{ type: "text", text: "Foundry response" }] },
    tool_calls: [{ id: "call-record", name: "update-record", arguments: { id: 7 } }],
  };
  writeFileSync(source, JSON.stringify([
    { ...capture({ id: "sse", traceId: "trace-response", ts: "2026-07-21T12:00:01Z" }), response_body: sse },
    { ...capture({ id: "nested", traceId: "trace-response", ts: "2026-07-21T12:00:02Z" }), response_body: nested },
    { ...capture({ id: "foundry", traceId: "trace-response", ts: "2026-07-21T12:00:03Z" }), response_body: undefined, response: foundry },
    { ...capture({ id: "anthropic-sse", traceId: "trace-response", ts: "2026-07-21T12:00:04Z" }), response_body: anthropicSse },
  ]));

  renderTraceViewer(source, output, "trace-response");
  const captures = viewerData(output).TRACE_CAPTURES;
  assert.equal(captures[0].response_view.encoding, "sse");
  assert.equal(captures[0].response_view.body.choices[0].message.content, "Checking now");
  assert.equal(captures[0].response_view.tool_calls[0].name, "lookup-weather");
  assert.equal(captures[0].response_view.tool_calls[0].input.city, "Paris");
  assert.equal(captures[1].response_view.body.choices[0].message.content, "Nested response");
  assert.equal(captures[2].response_view.body.content[0].text, "Foundry response");
  assert.equal(captures[2].response_view.tool_calls[0].name, "update-record");
  assert.equal(captures[2].response_view.tool_calls[0].input.id, 7);
  assert.equal(captures[3].response_view.body.content[0].text, "Anthropic response");
  assert.equal(captures[3].response_view.tool_calls[0].name, "read-record");
  assert.equal(captures[3].response_view.tool_calls[0].input.id, 7);
});

test("filters invalid timestamps while accepting numeric epoch timestamps", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-trace-viewer-timestamps-"));
  const source = join(root, "captures.json");
  const output = join(root, ".understudy", "viewer");
  writeFileSync(source, JSON.stringify([
    capture({ id: "epoch", traceId: "trace-time", ts: 1_699_999_999_999 }),
    capture({ id: "invalid", traceId: "trace-time", ts: "not-a-time" }),
  ]));

  const result = renderTraceViewer(source, output, "trace-time");
  assert.deepEqual(result.counts, {
    source_files: 1,
    captures: 1,
    workloads: 1,
    invalid_timestamp_filtered: 1,
  });
  const captures = viewerData(output).TRACE_CAPTURES;
  assert.equal(captures.length, 1);
  assert.equal(captures[0].request_id, "epoch");
  assert.equal(captures[0].ts, "2023-11-14T22:13:19.999Z");
});

test("requires a trace selection when a source contains multiple trace IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-trace-viewer-multi-"));
  const source = join(root, "captures");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "captures.json"), JSON.stringify([
    capture({ id: "one", traceId: "trace-a", ts: "2026-07-21T12:00:01Z" }),
    capture({ id: "two", traceId: "trace-b", ts: "2026-07-21T12:00:02Z" }),
  ]));

  assert.throws(
    () => renderTraceViewer(source, join(root, ".understudy", "viewer")),
    /contains 2 trace IDs; pass --trace-id/,
  );
});
