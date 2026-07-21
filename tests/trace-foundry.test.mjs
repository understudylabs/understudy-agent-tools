import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileTraceFoundry } from "../dist/trace-foundry.js";

const capture = (id, ts, messages, response) => ({
  schema_version: 4, request_id: id, ts, workload_name: "synthetic-automation",
  customer_request_body: JSON.stringify({ system: "Operate a synthetic project board.", messages, tools: [{ name: "update-record", input_schema: { type: "object" } }] }),
  response_body: JSON.stringify(response), status_code: 200,
});

test("builds a fresh generic DAG, benchmark, lazy viewer, and raw/parsed inspector", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-"));
  const source = join(root, ".understudy", "captures"), output = join(root, ".understudy", "benchmarks", "latest");
  mkdirSync(source, { recursive: true });
  const rows = [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [{ role: "user", content: "Set synthetic record 7 active" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true}" }] }], { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" }),
    capture("stale", "2026-07-01T12:00:00Z", [{ role: "user", content: "Old task" }], { content: [{ type: "text", text: "Old" }], stop_reason: "end_turn" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  assert.equal(result.counts.captures, 2); assert.equal(result.counts.stale_filtered, 1); assert.equal(result.counts.tasks, 1);
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8");
  assert.match(tasks, /semantic_outcome_not_exact_trajectory/); assert.doesNotMatch(tasks, /Example Customer/);
  const viewer = readFileSync(join(output, "viewer", "index.html"), "utf8");
  assert.match(viewer, /benchmark orchard/); assert.match(viewer, /Parsed JSON/); assert.match(viewer, />Raw</); assert.match(viewer, /data\/captures\/round-1.json/);
  assert.ok(readFileSync(join(output, "viewer", "data", "captures", "round-1.json"), "utf8").includes("raw"));
});

test("fails closed when no trace is within the requested window", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-stale-"));
  const source = join(root, ".understudy", "captures"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("old", "2026-07-01T00:00:00Z", [{ role: "user", content: "Old" }], {})));
  assert.throws(() => compileTraceFoundry(source, join(root, ".understudy", "out"), 3, new Date("2026-07-21T00:00:00Z")), /Refusing to compile a stale benchmark/);
});
