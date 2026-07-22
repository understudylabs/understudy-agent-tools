import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews } from "../dist/trace-foundry.js";

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
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], note: "data:image/png;base64,not-sse", stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [{ role: "user", content: "Set synthetic record 7 active" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true}" }] }], { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" }),
    capture("stale", "2026-07-01T12:00:00Z", [{ role: "user", content: "Old task" }], { content: [{ type: "text", text: "Old" }], stop_reason: "end_turn" }),
    capture("missing-time", undefined, [{ role: "user", content: "Malformed timestamp" }], {}),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  assert.equal(result.counts.captures, 2); assert.equal(result.counts.stale_filtered, 1); assert.equal(result.counts.invalid_timestamp_filtered, 1); assert.equal(result.counts.tasks, 1);
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8");
  assert.match(tasks, /semantic_outcome_not_exact_trajectory/); assert.doesNotMatch(tasks, /Example Customer/);
  const viewer = readFileSync(join(output, "viewer", "index.html"), "utf8");
  assert.match(viewer, /benchmark orchard/); assert.match(viewer, /Parsed JSON/); assert.match(viewer, />Raw</); assert.doesNotMatch(viewer, /data\/captures\/round-1.json/);
  const captures = readdirSync(join(output, "viewer", "data", "captures"));
  assert.ok(captures.every((name) => /^[a-f0-9]{40}\.json$/.test(name)));
  const first = captures.map((name) => JSON.parse(readFileSync(join(output, "viewer", "data", "captures", name), "utf8"))).find((row) => row.capture_id === "round-1");
  assert.equal(first.response.encoding, "json"); assert.equal(first.response.body.note, "data:image/png;base64,not-sse"); assert.ok(first.raw);
});

test("does not derive viewer paths from capture-controlled request IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-path-"));
  const source = join(root, ".understudy", "captures"), output = join(root, ".understudy", "benchmarks", "latest"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("../../escaped", "2026-07-20T00:00:00Z", [{ role: "user", content: "Safe path" }], {})));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const files = readdirSync(join(output, "viewer", "data", "captures"));
  assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{40}\.json$/); assert.equal(existsSync(join(output, "viewer", "escaped.json")), false);
});

test("fails closed when no trace is within the requested window", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-stale-"));
  const source = join(root, ".understudy", "captures"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("old", "2026-07-01T00:00:00Z", [{ role: "user", content: "Old" }], {})));
  assert.throws(() => compileTraceFoundry(source, join(root, ".understudy", "out"), 3, new Date("2026-07-21T00:00:00Z")), /Refusing to compile a stale benchmark/);
});

test("scopes workloads, preserves upstream requests, emits a resumable v1 environment, and applies review decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-lifecycle-"));
  const source = join(root, ".understudy", "captures"), output = join(root, ".understudy", "benchmarks", "automation"); mkdirSync(source, { recursive: true });
  const automation = capture("same-id", "2026-07-20T00:00:00Z", [{ role: "user", content: "Update record" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1, status: "done" } }] });
  automation.workload_name = "automation"; automation.upstream_request_body = JSON.stringify({ model: "upstream", messages: [] });
  const other = capture("same-id", "2026-07-20T00:00:01Z", [{ role: "user", content: "Other task" }], {}); other.workload_name = "other";
  writeFileSync(join(source, "captures.jsonl"), [automation, other].map(JSON.stringify).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"), { workload: "automation", batchSize: 10 });
  assert.equal(result.counts.captures, 1); assert.ok(existsSync(join(output, "capture-ledger.jsonl"))); assert.ok(existsSync(join(output, "goal-state.json")));
  const normalized = JSON.parse(readFileSync(join(output, "normalized-captures.jsonl"), "utf8")); assert.equal(normalized.upstream_request.model, "upstream"); assert.notEqual(normalized.capture_key, normalized.capture_id);
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8")); assert.equal(benchmark.executable, true); assert.equal(benchmark.verifiers.verifiers_api, "v1"); assert.equal(benchmark.verifiers.oracle_pass, true); assert.equal(benchmark.verifiers.sentinel_pass, true);
  assert.match(readFileSync(join(output, "environment", "understudy_trace_env", "taskset.py"), "utf8"), /verifiers\.v1/);
  assert.match(readFileSync(join(output, "viewer", "index.html"), "utf8"), /capability_fit/); assert.match(readFileSync(join(output, "viewer", "index.html"), "utf8"), /upstream_request/);
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8")); const reviews = join(root, "reviews.jsonl"); writeFileSync(reviews, JSON.stringify({ task_id: task.task_id, decision: "restrict", restrictions: ["only synthetic state"] }) + "\n");
  const imported = importTraceReviews(output, reviews); assert.equal(imported.status, "human_approved"); assert.match(readFileSync(join(output, "review-decisions.jsonl"), "utf8"), /decision_hash/);
  const plan = createTraceReplayPlan(output, ["incumbent", "candidate"]); assert.deepEqual(plan.models, ["incumbent", "candidate"]); assert.ok(plan.variants.includes("errors_and_retries")); assert.equal(plan.execution.provider_calls_performed, false);
});

test("uses unique capture keys when request ids collide and exposes DAG mutation evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-dag-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const first = capture("duplicate", "2026-07-20T00:00:00Z", [{ role: "user", content: "Do it" }, { role: "assistant", content: "A" }], {});
  const second = capture("duplicate", "2026-07-20T00:00:01Z", [{ role: "user", content: "Do it" }, { role: "assistant", content: "B" }], {});
  writeFileSync(join(source, "rows.json"), JSON.stringify([first, second])); compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8")); assert.equal(new Set(dag.nodes.map((node) => node.id)).size, 2); assert.equal(dag.edges[0].type, "same_depth_mutation");
});
