import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  assert.deepEqual(result.counts, { source_files: 1, captures: 2, workloads: 1 });
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
