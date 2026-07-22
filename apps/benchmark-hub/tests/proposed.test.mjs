import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The real in-tree foundry builds the fixture — the loader is tested against
// genuine understudy.trace_foundry.v1 output, not a hand-rolled imitation.
import { compileTraceFoundry } from "../../../dist/trace-foundry.js";
import { captureFilePath, getEntry, loadHub } from "./.build/lib/data-core.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-proposed-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const capture = (id, ts, messages, response) => ({
  schema_version: 4,
  request_id: id,
  ts,
  customer_request_body: JSON.stringify({
    system: "Operate a synthetic board.",
    messages,
    tools: [{ name: "update-record", input_schema: { type: "object" } }],
  }),
  response_body: JSON.stringify(response),
  status_code: 200,
});

const source = path.join(tmp, "captures-src");
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(
  path.join(source, "captures.jsonl"),
  [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set record 7 active" }], {
      content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7 } }],
      stop_reason: "tool_use",
    }),
    capture(
      "round-2",
      "2026-07-20T12:00:01Z",
      [
        { role: "user", content: "Set record 7 active" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] },
      ],
      { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" },
    ),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
const outDir = path.join(tmp, "proposed-demo");
compileTraceFoundry(source, outDir, 36500, new Date("2026-07-21T12:00:00Z"));

describe("proposed (trace-foundry) discovery", () => {
  it("recognizes a foundry output dir as a proposed entry", () => {
    const entry = getEntry("data--proposed-demo");
    assert.equal(entry.kind, "proposed");
    assert.equal(entry.foundry.schema_version, "understudy.trace_foundry.v1");
    assert.equal(entry.foundry.counts.captures, 2);
    assert.equal(entry.tasks.length, 1);
    assert.equal(entry.tasks[0].schema_version, "understudy.benchmark_task.v1");
    assert.equal(entry.dag.schema_version, "understudy.source_dag.v1");
    // benchmark.json is a known schema-name collision — only cross-checked.
    assert.deepEqual(entry.crossCheckErrors, []);
  });

  it("appears in loadHub alongside promoted entries", () => {
    const kinds = loadHub().map((e) => e.kind);
    assert.ok(kinds.includes("proposed"));
  });

  it("keeps the capture index lazy (pointers, not bodies)", () => {
    const entry = getEntry("data--proposed-demo");
    assert.equal(entry.captureIndex.length, 2);
    for (const ref of entry.captureIndex) {
      assert.equal(typeof ref.capture_id, "string");
      assert.equal(typeof ref.sha256, "string");
      assert.equal(ref.request, undefined);
      assert.equal(ref.response, undefined);
    }
  });

  it("resolves capture bodies on disk via captureFilePath", () => {
    const entry = getEntry("data--proposed-demo");
    const file = captureFilePath(entry, "round-1");
    assert.ok(file && fs.existsSync(file));
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(body.capture_id, "round-1");
    assert.equal(captureFilePath(entry, "no-such-capture"), null);
  });

  it("reads reviews.jsonl with newest-wins superseding", () => {
    const entry0 = getEntry("data--proposed-demo");
    const taskId = entry0.tasks[0].task_id;
    const line = (decision, at) =>
      JSON.stringify({
        schema_version: "understudy.benchmark_review.v1",
        benchmark_id: "proposed-demo",
        task_id: taskId,
        decision,
        note: "",
        created_at: at,
      });
    fs.writeFileSync(
      path.join(outDir, "reviews.jsonl"),
      [line("needs_more", "2026-07-21T13:00:00Z"), "not json", line("accept", "2026-07-21T14:00:00Z")].join("\n") + "\n",
    );
    const entry = getEntry("data--proposed-demo");
    assert.equal(entry.reviews.length, 2);
    assert.equal(entry.latestReviewByTask[taskId].decision, "accept");
    assert.equal(entry.diagnostics.skippedLines, 1);
    fs.rmSync(path.join(outDir, "reviews.jsonl"));
  });

  it("drops task lines with a wrong schema_version", () => {
    fs.appendFileSync(path.join(outDir, "tasks.jsonl"), JSON.stringify({ schema_version: "nope", task_id: "x" }) + "\n");
    const entry = getEntry("data--proposed-demo");
    assert.equal(entry.tasks.length, 1);
    assert.equal(entry.diagnostics.droppedRows, 1);
  });
});
