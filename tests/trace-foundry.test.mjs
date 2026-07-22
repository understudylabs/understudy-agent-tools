import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { once } from "node:events";
import { compileTraceFoundry, createTraceReplayPlan, extractJsonPayload, importTraceReviews, requestSystemPrompt, runTraceReplays } from "../dist/trace-foundry.js";
import { serveTraceFoundry } from "../dist/trace-foundry-server.js";

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
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8")); assert.equal(benchmark.schema_version, "understudy.benchmark_proposal.v1"); assert.equal(benchmark.executable, false); assert.equal(benchmark.status, "machine_compiled_review_pending"); assert.equal(benchmark.environment.format, "verifiers.v1"); assert.equal(benchmark.environment.verifiers_version_pin, "cb9c84969186f8a0954b1027320f225e6b6b0afb");
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8")); assert.equal(validation.tasks[0].oracle.score, 1); assert.ok(validation.tasks[0].sentinels.noop.score < 1);
  assert.match(readFileSync(join(output, "environment", "understudy_trace_env", "taskset.py"), "utf8"), /verifiers\.v1/);
  assert.match(readFileSync(join(output, "viewer", "index.html"), "utf8"), /capability_fit/); assert.match(readFileSync(join(output, "viewer", "index.html"), "utf8"), /upstream_request/);
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8")); const reviews = join(root, "reviews.jsonl"); writeFileSync(reviews, JSON.stringify({ task_id: task.task_id, decision: "restrict", restrictions: ["only synthetic state"] }) + "\n");
  const imported = importTraceReviews(output, reviews); assert.equal(imported.status, "human_approved"); assert.match(readFileSync(join(output, "review-decisions.jsonl"), "utf8"), /decision_hash/);
  const plan = createTraceReplayPlan(output, ["incumbent", "candidate"]); assert.deepEqual(plan.models, ["incumbent", "candidate"]); assert.ok(plan.variants.includes("errors_and_retries")); assert.equal(plan.execution.provider_calls_performed, false);
  assert.throws(() => runTraceReplays(output, ["candidate"], ["authentic_history"], 1, false), /pass --yes/);
});

test("exhausts the source in one invocation even when captures exceed the batch size", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-batches-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = Array.from({ length: 12 }, (_, i) => capture(`row-${i}`, `2026-07-20T00:00:${String(i).padStart(2, "0")}Z`, [{ role: "user", content: `Task ${i}` }], { content: [{ type: "tool_use", id: `c-${i}`, name: "update-record", input: { id: i } }] }));
  writeFileSync(join(source, "rows.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  const first = compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"), { batchSize: 10 });
  assert.equal(first.counts.captures, 12, "no silent batch truncation: all 12 captures compiled in one invocation");
  assert.notEqual(JSON.parse(readFileSync(join(output, "goal-state.json"), "utf8")).next_action, "compile_next_batch");
  assert.equal(readFileSync(join(output, "capture-ledger.jsonl"), "utf8").trim().split("\n").length, 12);
  const rerun = compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:02Z"), { batchSize: 10 });
  assert.equal(rerun.counts.captures, 12); assert.equal(readFileSync(join(output, "capture-ledger.jsonl"), "utf8").trim().split("\n").length, 12, "rerun stays idempotent");
});

test("serves the lazy local viewer and capture JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-server-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Serve" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1 } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z")); const server = serveTraceFoundry(output, 0); await once(server, "listening");
  try { const address = server.address(); assert.equal(typeof address, "object"); const base = `http://127.0.0.1:${address.port}`; const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /benchmark orchard/); const name = readdirSync(join(output, "viewer", "data", "captures"))[0]; const captureResponse = await fetch(`${base}/data/captures/${name}`); assert.equal(captureResponse.status, 200); assert.equal((await captureResponse.json()).capture_id, "one"); } finally { server.close(); }
});

test("records the incumbent model from capture metadata on tasks and the manifest, handling multi-model sets", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-incumbent-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  // Task A: two gpt-4o captures (upstream_model wins over requested_model).
  const a1 = capture("a-1", "2026-07-20T00:00:00Z", [{ role: "user", content: "Set record 1 active please" }], { content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 1 } }] });
  a1.provider = "openai"; a1.requested_model = "gpt-4o-alias"; a1.upstream_model = "gpt-4o";
  const a2 = capture("a-2", "2026-07-20T00:00:01Z", [{ role: "user", content: "Set record 1 active please" }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 1 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] }], { content: [{ type: "text", text: "Done" }] });
  a2.provider = "openai"; a2.upstream_model = "gpt-4o";
  // Task B: a different workload/prompt served by a Claude model (requested_model fallback).
  const b1 = capture("b-1", "2026-07-20T01:00:00Z", [{ role: "user", content: "Archive stale record 9 now" }], { content: [{ type: "tool_use", id: "c2", name: "archive-record", input: { id: 9 } }] });
  b1.workload_name = "other-workload"; b1.provider = "anthropic"; b1.requested_model = "claude-x-1";
  writeFileSync(join(source, "rows.json"), JSON.stringify([a1, a2, b1]));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const taskA = tasks.find((task) => task.tool_surface.includes("update-record"));
  const taskB = tasks.find((task) => task.tool_surface.includes("archive-record"));
  assert.deepEqual(taskA.incumbent, { model: "gpt-4o", provider: "openai", observed_calls: 2, models: [{ model: "gpt-4o", provider: "openai", observed_calls: 2 }] });
  assert.equal(taskB.incumbent.model, "claude-x-1");
  assert.equal(taskB.incumbent.provider, "anthropic");
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  // Manifest lists ALL observed models, dominant first; per-task entries carry their own incumbent.
  assert.equal(benchmark.incumbent.model, "gpt-4o");
  assert.deepEqual(benchmark.incumbent.models.map((m) => m.model), ["gpt-4o", "claude-x-1"]);
  assert.equal(benchmark.tasks.find((t) => t.task_id === taskA.task_id).incumbent.model, "gpt-4o");
  assert.equal(benchmark.tasks.find((t) => t.task_id === taskB.task_id).incumbent.model, "claude-x-1");
});

test("incumbent is null when captures carry no model metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-no-incumbent-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("bare", "2026-07-20T00:00:00Z", [{ role: "user", content: "No model recorded" }], {})));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  assert.equal(task.incumbent, null);
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  assert.equal(benchmark.incumbent, null);
  assert.equal(benchmark.tasks[0].incumbent, null);
});

test("uses unique capture keys when request ids collide and exposes DAG mutation evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-dag-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const first = capture("duplicate", "2026-07-20T00:00:00Z", [{ role: "user", content: "Do it" }, { role: "assistant", content: "A" }], {});
  const second = capture("duplicate", "2026-07-20T00:00:01Z", [{ role: "user", content: "Do it" }, { role: "assistant", content: "B" }], {});
  writeFileSync(join(source, "rows.json"), JSON.stringify([first, second])); compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8")); assert.equal(new Set(dag.nodes.map((node) => node.id)).size, 2); assert.equal(dag.edges[0].type, "same_depth_mutation");
});

test("reassembles SSE tool deltas and distinguishes an evidenced retry", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-sse-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const base = capture("failed", "2026-07-20T00:00:00Z", [{ role: "user", content: "Retry me" }], {}); base.status_code = 500;
  const retry = capture("retry", "2026-07-20T00:00:01Z", [{ role: "user", content: "Retry me" }], {});
  retry.response_body = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"update-","arguments":"{\\\"id\\\":"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"record","arguments":"1}"}}]}}]}\n\ndata: [DONE]\n';
  writeFileSync(join(source, "rows.json"), JSON.stringify([base, retry])); compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8")); assert.equal(dag.edges[0].type, "retry"); assert.equal(dag.edges[0].evidence.prior_error, true);
  const captures = readFileSync(join(output, "normalized-captures.jsonl"), "utf8").trim().split("\n").map(JSON.parse); const streamed = captures.find((row) => row.capture_id === "retry"); assert.equal(streamed.response.encoding, "sse"); assert.equal(streamed.response.tool_calls[0].function.name, "update-record"); assert.equal(streamed.response.tool_calls[0].function.arguments, '{"id":1}');
});

test("replay subprocess env is allowlisted, strips PRIME_*, and defaults to --no-push", async () => {
  const { buildReplayInvocation } = await import("../dist/trace-foundry.js");
  const parentEnv = {
    PATH: "/usr/bin", HOME: "/home/u", UV_CACHE_DIR: "/tmp/uv", PRIME_API_KEY: "prime-secret",
    PRIME_TEAM_ID: "team-1", AWS_SECRET_ACCESS_KEY: "aws-secret", GITHUB_TOKEN: "gh-secret",
    OPENAI_BASE_URL: "https://gateway.example/v1", OPENAI_API_KEY: "gw-key",
  };
  const offline = buildReplayInvocation("/bench/environment", "candidate", "authentic_history", 2, false, parentEnv);
  assert.ok(Object.keys(offline.env).every((key) => !key.startsWith("PRIME_")), "no PRIME_* in spawn env");
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in offline.env) && !("GITHUB_TOKEN" in offline.env), "non-allowlisted secrets stripped");
  assert.ok(offline.args.includes("--no-push"), "pinned verifiers offline switch present");
  assert.equal(offline.env.UV_CACHE_DIR, "/tmp/uv");
  assert.equal(offline.env.UNDERSTUDY_REPLAY_API_KEY, "gw-key");
  assert.deepEqual(offline.args.slice(offline.args.indexOf("--client.api-key-var"), offline.args.indexOf("--client.api-key-var") + 4), ["--client.api-key-var", "UNDERSTUDY_REPLAY_API_KEY", "--client.base-url", "https://gateway.example/v1"]);
  const pushing = buildReplayInvocation("/bench/environment", "candidate", "authentic_history", 2, true, parentEnv);
  assert.ok(!pushing.args.includes("--no-push"));
  assert.equal(pushing.env.PRIME_API_KEY, "prime-secret");
});

test("gold is graded semantically: equivalent phrasing scores 1 strict, noop scores 0, forbidden zeroes", async () => {
  const { scoreState, semanticArgumentsMatch } = await import("../dist/trace-foundry.js");
  const task = { outcome_contract: { required: [{ tool: "create-automation", observed_arguments: { app: "pipesim", schedule: "daily 9am run" } }], forbidden: [{ tool: "delete-record" }] } };
  const equivalent = scoreState(task, [{ tool: "create-automation", arguments: { app: "PipeSim", schedule: "Daily at 9am, run" } }]);
  assert.equal(equivalent.strict, 1, "different-but-equivalent phrasing satisfies the contract");
  assert.equal(scoreState(task, []).strict, 0, "a noop scores 0");
  assert.ok(scoreState(task, []).score < 1);
  const violating = scoreState(task, [{ tool: "create-automation", arguments: { app: "pipesim", schedule: "daily 9am run" } }, { tool: "delete-record", arguments: {} }]);
  assert.equal(violating.strict, 0, "forbidden-effect violations zero the strict score");
  assert.equal(semanticArgumentsMatch({ id: 7 }, { record_id: 7 }), true);
  assert.equal(semanticArgumentsMatch({ id: 7 }, { __wrong__: true }), false);
});

test("generated environment scores final state, not exact trajectory substrings", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-semantic-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create it" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1, status: "active" } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const taskset = readFileSync(join(output, "environment", "understudy_trace_env", "taskset.py"), "utf8");
  assert.match(taskset, /trace\.state/, "scores the per-rollout world state");
  assert.match(taskset, /_arguments_match/, "token-normalized semantic compare");
  assert.doesNotMatch(taskset, /str\(v\) in text/, "no raw-substring grading");
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /used_fixtures/, "fixtures are stateful and consumed in order");
  assert.match(world, /_arguments_match/);
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8"));
  assert.equal(validation.tasks[0].oracle.score, 1);
  assert.ok(Object.values(validation.tasks[0].sentinels).every((s) => s.score < 1));
});

test("promote consumes mixed review decisions: rejected tasks are excluded, not blockers", async () => {
  const { promoteTraceBenchmark } = await import("../dist/trace-foundry.js");
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-promote-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    capture("a1", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create automation alpha for pipesim" }], { content: [{ type: "tool_use", id: "x1", name: "update-record", input: { id: 1, status: "active" } }] }),
    capture("b1", "2026-07-20T01:00:00Z", [{ role: "user", content: "Archive report beta please" }], { content: [{ type: "tool_use", id: "x2", name: "archive-report", input: { report: "beta" } }] }),
  ];
  writeFileSync(join(source, "rows.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(tasks.length, 2);

  // Unreviewed benchmark refuses to promote.
  assert.throws(() => promoteTraceBenchmark(output), /unreviewed/);

  // Hub-shaped reviews.jsonl: accept one, reject the other; newest line per task wins.
  const review = (task_id, decision, created_at) => ({ schema_version: "understudy.benchmark_review.v1", benchmark_id: "out", task_id, decision, note: "", created_at });
  writeFileSync(join(output, "reviews.jsonl"), [
    review(tasks[0].task_id, "needs_more", "2026-07-21T01:00:00Z"),
    review(tasks[1].task_id, "reject", "2026-07-21T01:01:00Z"),
    review(tasks[0].task_id, "accept", "2026-07-21T02:00:00Z"),
  ].map(JSON.stringify).join("\n") + "\n");

  const result = promoteTraceBenchmark(output, { now: new Date("2026-07-21T03:00:00Z"), promotedBy: "reviewer-1" });
  assert.equal(result.promoted, 1); assert.equal(result.excluded, 1);
  const benchmark = JSON.parse(readFileSync(join(output, "benchmark.json"), "utf8"));
  assert.equal(benchmark.schema_version, "understudy.benchmark.v1");
  assert.equal(benchmark.status, "promoted"); assert.equal(benchmark.executable, true);
  assert.deepEqual(benchmark.promotion_blockers, []);
  assert.equal(benchmark.tasks.length, 1); assert.equal(benchmark.tasks[0].task_id, tasks[0].task_id);
  assert.equal(benchmark.taxonomy.length, 1, "taxonomy recomputed over accepted tasks");
  const record = JSON.parse(readFileSync(join(output, "promotion-record.json"), "utf8"));
  assert.equal(record.schema_version, "understudy.promotion_record.v1");
  assert.equal(record.promoted_by, "reviewer-1");
  assert.deepEqual(record.counts, { proposed: 2, accepted: 1, excluded: 1 });
  assert.equal(record.excluded_tasks[0].decision, "reject");
  assert.ok(existsSync(join(output, "benchmark-proposal.json")), "pre-promotion manifest preserved for audit");
});

const traced = (id, ts, workload, traceId, messages, response) => {
  const row = capture(id, ts, messages, response);
  row.workload_name = workload;
  row.trace_id = traceId; row.caller_span_id = id.padEnd(16, "0").slice(0, 16); row.trace_flags = "01"; row.trace_source = "w3c_traceparent"; row.trace_context_status = "valid";
  return row;
};
const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", TRACE_C = "cccccccccccccccccccccccccccccccc";

test("trace grouping: multi-workload trace becomes one task with workflow_sibling edges and merged tool surface", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-trace-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    traced("orch-1", "2026-07-20T00:00:00Z", "orchestrator", TRACE_A, [{ role: "user", content: "Handle incoming event 42" }], { content: [{ type: "tool_use", id: "o1", name: "update-record", input: { id: 42 } }] }),
    traced("orch-2", "2026-07-20T00:00:05Z", "orchestrator", TRACE_A, [{ role: "user", content: "Handle incoming event 42" }, { role: "assistant", content: [{ type: "tool_use", id: "o1", name: "update-record", input: { id: 42 } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "o1", content: "ok" }] }], { content: [{ type: "text", text: "done" }] }),
    traced("helper-1", "2026-07-20T00:00:02Z", "field-updater", TRACE_A, [{ role: "user", content: "Extract fields from event 42" }], { content: [{ type: "tool_use", id: "h1", name: "save-fields", input: { id: 42, status: "open" } }] }),
  ];
  writeFileSync(join(source, "rows.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  assert.equal(result.counts.tasks, 1, "one trace = one task despite two workloads");
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8"));
  assert.equal(dag.groups.length, 1);
  assert.equal(dag.groups[0].grouping_label, "trace_grouped/valid");
  assert.deepEqual(dag.groups[0].workloads, ["field-updater", "orchestrator"]);
  const sibling = dag.edges.find((edge) => edge.type === "workflow_sibling");
  assert.ok(sibling, "disjoint-prefix chain in the same trace links as workflow_sibling");
  assert.equal(sibling.confidence, "low");
  assert.ok(!dag.edges.some((edge) => edge.type === "destructive_mutation"), "sibling chains are not destructive mutations");
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  assert.equal(task.grouping_label, "trace_grouped/valid");
  assert.deepEqual(task.tool_surface, ["save-fields", "update-record"], "tool surface merges across workloads");
});

test("trace grouping: >120s silence splits, probes segregate as singleton, traceless captures fall back to heuristic", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-split-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    // TRACE_B: two multi-workload bursts separated by 300s -> trace_grouped/split x2
    traced("b1", "2026-07-20T00:00:00Z", "orchestrator", TRACE_B, [{ role: "user", content: "Burst one step one" }], { content: [{ type: "tool_use", id: "b1", name: "update-record", input: { id: 1 } }] }),
    traced("b2", "2026-07-20T00:00:10Z", "field-updater", TRACE_B, [{ role: "user", content: "Burst one step two" }], {}),
    traced("b3", "2026-07-20T00:05:10Z", "orchestrator", TRACE_B, [{ role: "user", content: "Burst two step one" }], {}),
    traced("b4", "2026-07-20T00:05:20Z", "field-updater", TRACE_B, [{ role: "user", content: "Burst two step two" }], {}),
    // TRACE_C: a 1-request probe -> singleton
    traced("probe", "2026-07-20T01:00:00Z", "domain-id", TRACE_C, [{ role: "user", content: "Which domain is this?" }], {}),
    // traceless -> heuristic_grouped
    capture("legacy", "2026-07-20T02:00:00Z", [{ role: "user", content: "Old style capture" }], {}),
  ];
  writeFileSync(join(source, "rows.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8"));
  const labels = dag.groups.map((group) => group.grouping_label).sort();
  assert.deepEqual(labels, ["heuristic_grouped", "singleton", "trace_grouped/split", "trace_grouped/split"]);
  const splitGroups = dag.groups.filter((group) => group.grouping_label === "trace_grouped/split");
  assert.notEqual(splitGroups[0].id, splitGroups[1].id);
  assert.equal(new Set(dag.groups.map((group) => group.id)).size, 4, "episode group ids never collide");
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(new Set(tasks.map((task) => task.task_id)).size, 4, "task ids unique across split episodes");
});

test("trace grouping: raw traceparent header parses, and a workload filter flags cross-workload traces instead of silently truncating", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-honesty-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const viaHeader = capture("tp-1", "2026-07-20T00:00:00Z", [{ role: "user", content: "Traceparent style capture one" }], { content: [{ type: "tool_use", id: "t1", name: "update-record", input: { id: 9 } }] });
  viaHeader.workload_name = "orchestrator"; viaHeader.traceparent = `00-${TRACE_A}-1111111111111111-01`;
  const viaHeader2 = capture("tp-2", "2026-07-20T00:00:05Z", [{ role: "user", content: "Traceparent style capture one" }, { role: "assistant", content: "ok" }], {});
  viaHeader2.workload_name = "orchestrator"; viaHeader2.traceparent = `00-${TRACE_A}-2222222222222222-01`;
  const hidden = traced("hidden", "2026-07-20T00:00:02Z", "helper", TRACE_A, [{ role: "user", content: "Helper call outside the filter" }], {});
  writeFileSync(join(source, "rows.jsonl"), [viaHeader, viaHeader2, hidden].map(JSON.stringify).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"), { workload: "orchestrator" });
  assert.equal(result.counts.captures, 2);
  const normalized = readFileSync(join(output, "normalized-captures.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(normalized[0].trace.trace_id, TRACE_A, "traceparent header parsed into the trace block");
  assert.equal(normalized[0].trace.valid, true);
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  assert.equal(task.status, "needs_review", "cross-workload trace under a filter is flagged, not truncated");
  assert.equal(task.close_call, true);
  const claim = task.claims.find((row) => String(row.claim).includes("workflow may be incomplete"));
  assert.ok(claim, "incompleteness claim present");
  assert.match(claim.claim, /helper/);
  assert.deepEqual(task.trace.workloads_spanned, ["helper", "orchestrator"]);
});

test("trace grouping: invalid trace context falls back to heuristic grouping", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-invalid-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const bad = capture("bad", "2026-07-20T00:00:00Z", [{ role: "user", content: "Invalid trace context" }], {});
  bad.trace_id = TRACE_A; bad.trace_context_status = "invalid";
  const zero = capture("zero", "2026-07-20T00:00:01Z", [{ role: "user", content: "All zero trace id" }], {});
  zero.trace_id = "0".repeat(32);
  writeFileSync(join(source, "rows.jsonl"), [bad, zero].map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const dag = JSON.parse(readFileSync(join(output, "source-dag.json"), "utf8"));
  assert.ok(dag.groups.every((group) => group.grouping_label === "heuristic_grouped"));
});

test("import-reviews no longer demands unanimity", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-unanimity-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    capture("u1", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create thing one" }], { content: [{ type: "tool_use", id: "y1", name: "update-record", input: { id: 1, status: "one" } }] }),
    capture("u2", "2026-07-20T01:00:00Z", [{ role: "user", content: "Archive thing two" }], { content: [{ type: "tool_use", id: "y2", name: "archive-report", input: { report: "two" } }] }),
  ];
  writeFileSync(join(source, "rows.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const reviews = join(root, "reviews.jsonl");
  writeFileSync(reviews, [
    JSON.stringify({ task_id: tasks[0].task_id, decision: "accept" }),
    JSON.stringify({ task_id: tasks[1].task_id, decision: "reject" }),
  ].join("\n") + "\n");
  const imported = importTraceReviews(output, reviews);
  assert.equal(imported.accepted, 1);
  assert.equal(imported.status, "human_approved", "one honest reject no longer vetoes the benchmark");
});

// ---------------------------------------------------------------------------
// Widened deterministic contract: four entry kinds beyond state_effect
// ---------------------------------------------------------------------------

test("scoreContract: each new entry kind flips met/unmet deterministically over the event stream", async () => {
  const { scoreContract, contractEntryMet } = await import("../dist/trace-foundry.js");
  const task = { outcome_contract: { required: [
    { type: "state_effect", tool: "update-record", observed_arguments: { id: 7, status: "active" } },
    { type: "read_obligation", tool: "lookup-record", arguments_semantic: { id: 7 } },
    { type: "value_propagation", source: { kind: "tool_result", call_id: "c1" }, value: "rec-7-name", must_reach: { kind: "tool_args", tool: "update-record" } },
    { type: "value_propagation", source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } },
    { type: "response_obligation", kind: "json_parses" },
    { type: "response_obligation", kind: "schema_valid", expected_keys: ["party"] },
    { type: "response_obligation", kind: "contains_category", expected: "external_customer" },
  ], forbidden: [] } };
  const calls = [
    { name: "lookup-record", arguments: { id: 7 } },
    { name: "update-record", arguments: { id: 7, status: "active", name: "rec-7-name" } },
  ];
  const finalResponse = '{"party": "external_customer", "reasoning": "Jordan Doe is the buyer"}';
  const full = scoreContract(task, { calls, finalResponse });
  assert.equal(full.recall, 1);
  assert.equal(full.strict, 1);
  // Missing final response leaves final-response-dependent entries unmet.
  const noFinal = scoreContract(task, { calls, finalResponse: "" });
  assert.ok(noFinal.recall < 1);
  assert.equal(noFinal.strict, 0);
  // A noop meets nothing.
  const noop = scoreContract(task, { calls: [], finalResponse: "" });
  assert.equal(noop.recall, 0);
  // Individual transitions.
  assert.equal(contractEntryMet({ type: "response_obligation", kind: "json_parses" }, { calls: [], finalResponse: "not json" }), false);
  assert.equal(contractEntryMet({ type: "response_obligation", kind: "schema_valid", expected_keys: ["missing"] }, { calls: [], finalResponse: '{"party":1}' }), false);
  assert.equal(contractEntryMet({ type: "value_propagation", value: "abc-123", must_reach: { kind: "tool_args", tool: "send-email" } }, { calls: [{ name: "send-email", arguments: { body: "code abc-123" } }] }), true);
  assert.equal(contractEntryMet({ type: "value_propagation", value: "abc-123", must_reach: { kind: "tool_args", tool: "send-email" } }, { calls: [{ name: "other-tool", arguments: { body: "code abc-123" } }] }), false);
});

test("scoreContract: a forbidden value that propagates zeroes the score outright", async () => {
  const { scoreContract } = await import("../dist/trace-foundry.js");
  const task = { outcome_contract: {
    required: [{ type: "response_obligation", kind: "contains_category", expected: "billing" }],
    forbidden: [{ type: "forbidden_value", value: "ssn 123-45-6789" }],
  } };
  const clean = scoreContract(task, { calls: [], finalResponse: "category: billing" });
  assert.equal(clean.strict, 1);
  const leakedInResponse = scoreContract(task, { calls: [], finalResponse: "billing — ssn 123-45-6789" });
  assert.equal(leakedInResponse.strict, 0);
  assert.equal(leakedInResponse.score, 0);
  const leakedInArgs = scoreContract(task, { calls: [{ name: "send-email", arguments: { body: "ssn 123-45-6789" } }], finalResponse: "billing" });
  assert.equal(leakedInArgs.policy, 0);
});

test("offlineValidationRow: obligation contracts pass their own oracle and fail every sentinel", async () => {
  const { offlineValidationRow } = await import("../dist/trace-foundry.js");
  const row = offlineValidationRow({ task_id: "t-obligations", outcome_contract: { required: [
    { type: "value_propagation", source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } },
    { type: "response_obligation", kind: "schema_valid", expected_keys: ["party"] },
    { type: "response_obligation", kind: "json_parses" },
  ], forbidden: [] } });
  assert.equal(row.oracle.strict, 1, "the contract's own oracle events satisfy it by construction");
  assert.ok(row.sentinels.noop.score < 1);
  assert.ok(row.sentinels.wrong_value.score < 1);
  assert.ok(row.sentinels.write_everything.score < 1);
  // Mixed with a state effect, unchanged.
  const mixed = offlineValidationRow({ task_id: "t-mixed", outcome_contract: { required: [
    { tool: "update-record", observed_arguments: { id: 1 } },
    { type: "read_obligation", tool: "lookup-record", arguments_semantic: { id: 1 } },
  ], forbidden: [] } });
  assert.equal(mixed.oracle.strict, 1);
  assert.ok(Object.values(mixed.sentinels).every((s) => s.score < 1));
});

test("refreshOfflineValidation rewrites only the changed tasks' rows", async () => {
  const { refreshOfflineValidation } = await import("../dist/trace-foundry.js");
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-refresh-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  // The captured final response carries the gold text the widened response
  // obligation is verified against (real-gold oracle, not self-satisfying).
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create it" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1, status: "active" } }, { type: "text", text: "All done." }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  task.outcome_contract.required.push({ type: "response_obligation", kind: "contains_category", expected: "done" });
  assert.equal(refreshOfflineValidation(output, [task]), true);
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8"));
  const row = validation.tasks.find((r) => r.task_id === task.task_id);
  assert.equal(row.oracle.strict, 1);
  assert.equal(row.oracle.met.length, 2, "refreshed row scores the widened contract");
  assert.equal(row.oracle.missing_gold, undefined, "gold present — no missing-gold diagnostic");
  // An obligation the CAPTURED gold response cannot satisfy is honestly broken.
  const broken = { ...task, outcome_contract: { ...task.outcome_contract, required: [...task.outcome_contract.required, { type: "response_obligation", kind: "contains_category", expected: "never-in-the-gold-response" }] } };
  assert.equal(refreshOfflineValidation(output, [broken]), true);
  const brokenRow = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8")).tasks.find((r) => r.task_id === task.task_id);
  assert.equal(brokenRow.oracle.strict, 0);
  assert.equal(brokenRow.oracle.missing_gold, undefined, "gold present but unsatisfied — broken, not unverifiable");
});

test("responseProjection extracts OpenAI chat.completion tool calls so their mutations reach the contract", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-openai-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const row = capture("openai-1", "2026-07-20T00:00:00Z", [{ role: "user", content: "Save the summary" }], {});
  row.response_body = JSON.stringify({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "save-summary", arguments: "{\"status\":\"skipped\"}" } }] }, finish_reason: "tool_calls" }] });
  writeFileSync(join(source, "one.json"), JSON.stringify(row));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  assert.deepEqual(task.tool_surface, ["save-summary"]);
  assert.equal(task.outcome_contract.required.length, 1);
  assert.equal(task.outcome_contract.required[0].tool, "save-summary");
});

test("generated taskset scores the widened contract kinds against events and the final response", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-widened-env-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create it" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1 } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const taskset = readFileSync(join(output, "environment", "understudy_trace_env", "taskset.py"), "utf8");
  for (const marker of ["_entry_met", "value_propagation", "response_obligation", "read_obligation", "forbidden_value", "_final_text", "json_parses", "contains_category", "schema_valid"]) {
    assert.match(taskset, new RegExp(marker), `taskset.py handles ${marker}`);
  }
  assert.doesNotMatch(taskset, /str\(v\) in text/);
});

test("fixtures with bare JSON booleans generate valid Python (fixtures.json sidecar, never inlined)", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-boolfix-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  // A tool RESULT carrying bare true/false — inlining this into world.py used
  // to produce `FIXTURES = [... {"enabled": false ...}]` → NameError in Python.
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [
    { role: "user", content: "Create it" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: { enabled: false, archived: true, note: null } }] },
  ], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1 } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /FIXTURES = json\.loads\(\(Path\(__file__\)\.parent \/ "fixtures\.json"\)\.read_text\(\)\)/);
  assert.doesNotMatch(world, /FIXTURES = \[/, "fixtures are never inlined into Python source");
  const fixtures = JSON.parse(readFileSync(join(output, "environment", "understudy_trace_env", "servers", "fixtures.json"), "utf8"));
  assert.ok(fixtures.some((f) => f.tool === "get-record"));
});

test("anchorArguments keeps ids/numbers/short values and drops prose", async () => {
  const { anchorArguments, stateEffectMet } = await import("../dist/trace-foundry.js");
  const anchors = anchorArguments({
    conversationId: "1980f239-2073-4231-9d5c-3174fe334214",
    path: "deals/2026/summary.md",
    count: 3,
    enabled: true,
    stage: "closed won",
    body: "Hey team, great chatting today! Quick recap of everything we discussed on the call about the renewal and the follow-ups we promised to send over…",
    nested: { dealId: "d-12345678901234567890", notes: "a very long free text paragraph that should absolutely not be required for a match to succeed here" },
  });
  assert.deepEqual(Object.keys(anchors).sort(), ["conversationId", "count", "enabled", "nested", "path", "stage"]);
  assert.deepEqual(Object.keys(anchors.nested), ["dealId"]);

  // met/unmet under the anchor rule: right tool + right anchors + candidate's OWN prose = met.
  const rule = { type: "state_effect", tool: "write-document", observed_arguments: { conversationId: "1980f239-2073-4231-9d5c-3174fe334214", content: "the incumbent's entire original document body, hundreds of words long..." } };
  assert.equal(stateEffectMet(rule, { tool: "write-document", arguments: { conversationId: "1980f239-2073-4231-9d5c-3174fe334214", content: "a DIFFERENT but perfectly good document" } }), true, "candidate prose no longer blocks the match");
  assert.equal(stateEffectMet(rule, { tool: "write-document", arguments: { conversationId: "wrong-conversation" } }), false, "anchor mismatch still fails");
  assert.equal(stateEffectMet(rule, { tool: "update-record", arguments: {} }), false, "tool mismatch fails");
  // Authored arguments_semantic wins when present.
  const authoredRule = { ...rule, arguments_semantic: { conversationId: "1980f239-2073-4231-9d5c-3174fe334214" } };
  assert.equal(stateEffectMet(authoredRule, { tool: "write-document", arguments: { conversationId: "1980f239-2073-4231-9d5c-3174fe334214" } }), true);
  // Zero anchors + no semantics => tool call with any args suffices (documented).
  const proseOnly = { type: "state_effect", tool: "send-email", observed_arguments: { body: "long free text only, nothing discrete in here at all beyond ordinary words" } };
  assert.equal(stateEffectMet(proseOnly, { tool: "send-email", arguments: { anything: 1 } }), true);
});

test("wrong_value sentinel corrupts anchors (or the tool when there are none) — the gate still discriminates", async () => {
  const { offlineValidationRow } = await import("../dist/trace-foundry.js");
  const anchored = offlineValidationRow({ task_id: "t-anchored", outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "record-12345678901234567", note: "long prose here that anchors ignore entirely for the match" } }], forbidden: [], grading: "g" } });
  assert.equal(anchored.oracle.strict, 1);
  assert.equal(anchored.sentinels.noop.strict, 0);
  assert.equal(anchored.sentinels.wrong_value.strict, 0);
  const proseOnly = offlineValidationRow({ task_id: "t-prose", outcome_contract: { required: [{ type: "state_effect", tool: "send-email", observed_arguments: { body: "only long free text in the observed arguments of this call" } }], forbidden: [], grading: "g" } });
  assert.equal(proseOnly.oracle.strict, 1);
  assert.equal(proseOnly.sentinels.wrong_value.strict, 0, "tool corrupted when no anchors exist");
});

test("rejected calls (status=error) never satisfy contract entries", async () => {
  const { contractEntryMet } = await import("../dist/trace-foundry.js");
  const rule = { type: "state_effect", tool: "update-record", observed_arguments: { id: 7 } };
  assert.equal(contractEntryMet(rule, { calls: [{ tool: "update-record", arguments: { id: 7 }, status: "error" }] }), false);
  assert.equal(contractEntryMet(rule, { calls: [{ tool: "update-record", arguments: { id: 7 } }] }), true);
});

test("empty contract is not judgeable: no vacuous 100%s from either scorer entrypoint", async () => {
  const { scoreState, scoreContract } = await import("../dist/trace-foundry.js");
  const empty = { task_id: "t", outcome_contract: { required: [], forbidden: [], grading: "g" } };
  const s1 = scoreState(empty, []);
  assert.equal(s1.judgeable, false);
  assert.equal(s1.recall, null);
  assert.equal(s1.score, null);
  const s2 = scoreContract(empty, { calls: [], finalResponse: "" });
  assert.equal(s2.judgeable, false);
  assert.equal(s2.recall, null);
});

test("generated world validates calls against declared/inferred schemas and journals live", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-validate-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create it" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1, status: "active" } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /def _validate\(/, "schema validation gate exists");
  assert.match(world, /SCHEMAS = json\.loads/, "schemas load from the sidecar");
  assert.match(world, /missing required field/, "AutomationBench-style rejection payloads");
  assert.match(world, /UNDERSTUDY_LIVE_JOURNAL/, "live journal is env-gated");
  assert.match(world, /def _accept\(/, "every tool routes through the validating, journaling acceptor");
  assert.match(world, /self\._accept\(/);
  const schemas = JSON.parse(readFileSync(join(output, "environment", "understudy_trace_env", "servers", "schemas.json"), "utf8"));
  assert.ok(schemas["update-record"], "contract tool has a schema");
  assert.equal(schemas["update-record"].inferred, true, "observed-only tools get an inferred schema");
  assert.ok(schemas["update-record"].required.includes("id"));
  // taskset filters rejected events before matching
  const taskset = readFileSync(join(output, "environment", "understudy_trace_env", "taskset.py"), "utf8");
  assert.match(taskset, /status.*!= .error./, "invalid calls never satisfy contract entries");
  assert.match(taskset, /_anchor_arguments/, "python scorer uses the same anchor rule");
});

test("fallback rubric synthesis: structured and unstructured oracle responses", async () => {
  const { fallbackRubricEntries } = await import("../dist/trace-foundry.js");
  const structured = fallbackRubricEntries('{"status": "created", "automation_id": "auto-1"}', "req-1");
  assert.deepEqual(structured.map((e) => e.kind), ["json_parses", "schema_valid"]);
  assert.ok(structured.every((e) => e.provenance === "fallback_minimal"));
  const unstructured = fallbackRubricEntries("Done — created automation auto-33019284756102 for request req-8021847362514908.", "please handle request req-8021847362514908");
  assert.ok(unstructured.length > 0);
  assert.ok(unstructured.every((e) => e.provenance === "fallback_minimal"));
});

test("tightenSchema: 100% presence with N>=5 promotes; 96% and N<5 do not; enums infer from small closed sets", async () => {
  const { tightenSchema } = await import("../dist/trace-foundry.js");
  const base = { inferred: false, required: ["executionId"], properties: { executionId: "string", metadata: "object" } };
  const call = (status) => ({ executionId: "exec-12345678901234567", metadata: { status, attempt: 1 } });
  // 27/27 calls carry metadata with a two-value status enum.
  const tightened = tightenSchema(base, Array.from({ length: 27 }, (_, i) => call(i % 2 ? "skipped" : "completed")));
  assert.equal(tightened.observed_n, 27);
  assert.ok(tightened.required_by_observation.includes("metadata"), "unanimous declared-optional property promotes");
  assert.ok(!tightened.required_by_observation.includes("executionId"), "declared-required properties never duplicate");
  assert.deepEqual(tightened.enums_by_observation["metadata.status"], ["completed", "skipped"]);
  assert.deepEqual(tightened.observation_counts["metadata"], [27, 27]);
  assert.deepEqual(tightened.required, ["executionId"], "declared required is preserved as-is");
  // 96% presence (24/25) does NOT promote.
  const mostly = tightenSchema(base, [...Array.from({ length: 24 }, () => call("completed")), { executionId: "exec-12345678901234567" }]);
  assert.ok(!mostly.required_by_observation.includes("metadata"));
  // N=4 unanimous does NOT promote (below the observation floor).
  const few = tightenSchema(base, Array.from({ length: 4 }, () => call("completed")));
  assert.ok(!few.required_by_observation.includes("metadata"));
  // >5 distinct values or long prose never become enums.
  const wide = tightenSchema(base, Array.from({ length: 8 }, (_, i) => ({ executionId: "e", metadata: { status: `state-${i}` } })));
  assert.equal(wide.enums_by_observation["metadata.status"], undefined);
  const prose = tightenSchema(base, Array.from({ length: 6 }, () => ({ executionId: "e", metadata: { status: "a long free text status message with many words in it" } })));
  assert.equal(prose.enums_by_observation["metadata.status"], undefined);
});

test("validateCallAgainstSchema: observation-tightened rejects with evidence-bearing messages; compliant calls pass", async () => {
  const { validateCallAgainstSchema } = await import("../dist/trace-foundry.js");
  const schemas = { "save-execution-summary": {
    inferred: false, required: ["executionId"], properties: { executionId: "string", metadata: "object" },
    required_by_observation: ["metadata", "metadata.status"],
    enums_by_observation: { "metadata.status": ["completed", "skipped"] },
    observed_n: 27, observation_counts: { metadata: [27, 27], "metadata.status": [27, 27] },
  } };
  assert.equal(validateCallAgainstSchema("save-execution-summary", { executionId: "e-1", metadata: { status: "completed" } }, schemas), null);
  assert.equal(
    validateCallAgainstSchema("save-execution-summary", { executionId: "e-1" }, schemas),
    "missing field 'metadata' — required by observed usage (27/27 calls)");
  assert.equal(
    validateCallAgainstSchema("save-execution-summary", { executionId: "e-1", metadata: { status: "exploded" } }, schemas),
    "field 'metadata.status' must be one of [\"completed\",\"skipped\"] — required by observed usage");
  assert.equal(validateCallAgainstSchema("save-execution-summary", {}, schemas), "missing required field 'executionId'");
  assert.match(String(validateCallAgainstSchema("unknown-tool", {}, schemas)), /unknown tool/);
});

test("enum_violation sentinel: a rejected out-of-enum call scores 0 while the oracle stays 1", async () => {
  const { offlineValidationRow } = await import("../dist/trace-foundry.js");
  const task = { task_id: "t-enum", outcome_contract: { required: [
    { type: "state_effect", tool: "save-execution-summary", observed_arguments: { executionId: "exec-12345678901234567", metadata: { status: "completed" } } },
  ], forbidden: [], grading: "g" } };
  const schemas = { "save-execution-summary": { required: [], properties: {}, required_by_observation: ["metadata"], enums_by_observation: { "metadata.status": ["completed", "skipped"] }, observed_n: 27, observation_counts: { metadata: [27, 27] } } };
  const row = offlineValidationRow(task, schemas);
  assert.equal(row.oracle.strict, 1, "observed usage always passes its own tightened validation");
  assert.ok(row.sentinels.enum_violation, "enum sentinel emitted when a contract tool carries enums");
  assert.equal(row.sentinels.enum_violation.strict, 0, "rejected enum-violating call never satisfies the contract");
  assert.ok(row.sentinels.enum_violation.score < 1);
  // No enums anywhere: sentinel is not emitted.
  const plain = offlineValidationRow(task, { "save-execution-summary": { required: [], properties: {} } });
  assert.equal(plain.sentinels.enum_violation, undefined);
});

test("compile + regenerate-env: observation tightening lands in schemas.json and the generated world", async () => {
  const { regenerateEnvironment } = await import("../dist/trace-foundry.js");
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-tighten-")), source = join(root, "captures"), output = join(root, "out");
  mkdirSync(source, { recursive: true });
  // Six tasks; the DECLARED schema marks metadata optional, yet every observed
  // save-execution-summary call carries metadata.status in {skipped, completed}.
  const declaredTool = { name: "save-execution-summary", input_schema: { type: "object", required: ["executionId"], properties: { executionId: { type: "string" }, metadata: { type: "object" } } } };
  const rows = Array.from({ length: 6 }, (_, i) => ({
    schema_version: 4, request_id: `c-${i}`, ts: `2026-07-20T0${i}:00:00Z`, workload_name: "synthetic-automation", status_code: 200,
    customer_request_body: JSON.stringify({ system: "Operate a synthetic automation runner.", messages: [{ role: "user", content: `Handle synthetic execution ${i} of the nightly automation batch` }], tools: [declaredTool] }),
    response_body: JSON.stringify({ content: [{ type: "tool_use", id: `call-${i}`, name: "save-execution-summary", input: { executionId: `exec-000000000000000${i}`, metadata: { status: i % 2 ? "skipped" : "completed" } } }], stop_reason: "tool_use" }),
  }));
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const schemasPath = join(output, "environment", "understudy_trace_env", "servers", "schemas.json");
  const check = () => {
    const schemas = JSON.parse(readFileSync(schemasPath, "utf8"));
    const tool = schemas["save-execution-summary"];
    assert.equal(tool.observed_n, 6);
    assert.ok(tool.required_by_observation.includes("metadata"), "metadata promoted from unanimous observation");
    assert.deepEqual(tool.enums_by_observation["metadata.status"], ["completed", "skipped"]);
    const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
    assert.match(world, /required_by_observation/);
    assert.match(world, /required by observed usage/);
    assert.match(world, /enums_by_observation/);
    assert.match(world, /_rejection_reply/);
    assert.match(world, /UNDERSTUDY_STRICT_VALIDATION/, "tightening is a documented, defeatable strictness choice");
  };
  check();
  // Rejections are recoverable error events, never writes, never contract satisfaction:
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /"status": "error"/);
  assert.match(world, /if mutating:\n                self\.state\.writes\.append\(event\)/);
  // regenerate-env recomputes the same stats from normalized-captures.jsonl alone.
  writeFileSync(schemasPath, "{}\n");
  const regen = regenerateEnvironment(output);
  assert.equal(regen.oracle_pass, true);
  check();
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8"));
  assert.ok(validation.tasks.every((row) => !row.sentinels.enum_violation || row.sentinels.enum_violation.score < 1), "enum sentinel discriminates offline");
  assert.ok(validation.tasks.some((row) => row.sentinels.enum_violation), "enum sentinel present for the enum-carrying tool");
});

test("generation-time self-check: structural sentinels per task, stamped on tasks.jsonl and the manifest", async () => {
  const { selfCheckTask, runFoundrySelfCheck } = await import("../dist/trace-foundry.js");
  // Unit: each check fires on its own fixture.
  const goodTask = {
    task_id: "task-good",
    title: "email: quarterly report",
    outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: 7 } }] },
    tool_definitions: [{ name: "update-record" }],
    source: { captures: [{ capture_id: "c1", pointer: "captures.jsonl#L1", sha256: "x" }] },
  };
  assert.deepEqual(selfCheckTask(goodTask, { task_id: "task-good", prompt: "Set synthetic record 7 active" }, { schemasPresent: true }), []);
  const failures = selfCheckTask(
    {
      task_id: "task-bad",
      title: "email: quarterly report",
      outcome_contract: { required: [] },
      tool_definitions: [],
      source: { captures: [{ capture_id: "c2", pointer: "/Users/somebody/captures/x.jsonl#L1", sha256: "y" }] },
    },
    { task_id: "task-bad", prompt: "email: quarterly report" },
    { schemasPresent: false },
  );
  const checks = failures.map((f) => f.check);
  assert.ok(checks.includes("prompt_equals_title"), "the display-title-instead-of-prompt class is structural, not case-by-case");
  assert.ok(checks.includes("empty_contract"));
  assert.ok(checks.includes("schemas_missing"));
  assert.ok(checks.includes("absolute_path"));
  // missing_tool_definitions fires when the contract requires calls.
  const noDefs = selfCheckTask(
    { ...goodTask, tool_definitions: [] },
    { task_id: "task-good", prompt: "Set synthetic record 7 active" },
    { schemasPresent: true },
  );
  assert.deepEqual(noDefs.map((f) => f.check), ["missing_tool_definitions"]);
  // prompt row missing entirely.
  assert.ok(selfCheckTask(goodTask, null, { schemasPresent: true }).some((f) => f.check === "prompt_missing"));

  // Integration: a fresh compile stamps task.self_check + manifest.self_check.
  const root = mkdtempSync(join(tmpdir(), "understudy-selfcheck-"));
  const source = join(root, "captures"), output = join(root, "out");
  mkdirSync(source, { recursive: true });
  const row = capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" });
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(row) + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  assert.equal(result.self_check.schema_version, "understudy.foundry_self_check.v1");
  assert.equal(result.self_check.checked, 1);
  const tasks = readFileSync(join(output, "tasks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(tasks.every((task) => task.self_check && typeof task.self_check.ok === "boolean"), "self_check stamped on every task");
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.self_check, result.self_check);
  // runFoundrySelfCheck is re-runnable in place (regenerate-env path).
  const rerun = runFoundrySelfCheck(output, tasks);
  assert.equal(rerun.checked, tasks.length);
});

test("fallback rubric records binding anchor caps as visible cap_warning claims (no silent caps)", async () => {
  const { ensureJudgeableContract } = await import("../dist/trace-foundry.js");
  const task = { task_id: "task-caps", title: "cap test", outcome_contract: { required: [] }, claims: [] };
  // Five distinct id-shaped anchors in the final response — the rubric keeps 3.
  const finalText = [1, 2, 3, 4, 5].map((i) => `created automation auto-3301928475610${i} ok`).join("\n");
  assert.equal(ensureJudgeableContract(task, finalText, ""), true);
  const capClaims = task.claims.filter((claim) => claim.provenance === "cap_warning");
  assert.equal(capClaims.length, 1);
  assert.match(capClaims[0].claim, /kept 3 of 5/);
  assert.equal(task.outcome_contract.required.filter((rule) => rule.kind === "contains_category").length, 3);
});

// ---------------------------------------------------------------------------
// Gold-leakage audit: contract targets must not be verbatim-readable in
// candidate-facing surfaces (fixtures / schemas) unless the task's own inputs
// already carry them. Report-only — nothing is redacted.
// ---------------------------------------------------------------------------

test("leakage audit: true positive (gold only in fixtures), benign input overlap, short values skipped", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const goldSecret = "confidential-report-Q3-final-9981";
  const inputValue = "record-7781-target-identifier";
  const tasks = [{
    task_id: "t-leak",
    outcome_contract: { required: [
      // Gold argument the prompt never mentions — leaks via a fixture echo.
      { type: "state_effect", tool: "update-record", observed_arguments: { document: goldSecret } },
      // Gold argument the user PROMPT already carries — benign input.
      { type: "state_effect", tool: "update-record", observed_arguments: { id: inputValue } },
      // Short value — below MIN_GOLD_LEN, never flagged.
      { type: "state_effect", tool: "update-record", observed_arguments: { status: "active" } },
      // Response gold string readable in schemas.json's observed error example.
      { type: "response_obligation", kind: "contains_category", expected: "the rollback completed without data loss" },
    ], forbidden: [] },
  }];
  const taskRows = [{ task_id: "t-leak", prompt: `Please update ${inputValue} for me`, system_prompt: "", source_messages: [] }];
  const fixtures = [
    { tool: "get-record", arguments: {}, content: `{"id":"${inputValue}","document":"${goldSecret}","status":"active"}` },
  ];
  const schemas = { "update-record": { observed_error_example: "ERROR: the rollback completed without data loss" } };
  const audit = auditGoldLeakage(tasks, taskRows, fixtures, schemas);
  assert.equal(audit.status, "findings");
  const kinds = audit.findings.map((f) => `${f.kind}@${f.location.split("/").pop()}`).sort();
  assert.deepEqual(kinds, ["response_gold_string@schemas.json", "state_effect_value@fixtures.json"]);
  const leak = audit.findings.find((f) => f.kind === "state_effect_value");
  assert.equal(leak.task_id, "t-leak");
  assert.equal(leak.excerpt, goldSecret);
  assert.ok(!audit.findings.some((f) => f.excerpt.includes(inputValue)), "input-carried values are benign, not findings");
  assert.ok(!audit.findings.some((f) => f.excerpt === "active"), "short values are skipped");
});

test("leakage audit: clean when contract targets never surface outside the inputs", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const tasks = [{ task_id: "t-clean", outcome_contract: { required: [
    { type: "state_effect", tool: "update-record", observed_arguments: { note: "a long enough gold note value" } },
    { type: "value_propagation", value: "propagated-target-value-123456", must_reach: { kind: "final_response" } },
  ], forbidden: [] } }];
  const taskRows = [{ task_id: "t-clean", prompt: "Do the thing", system_prompt: "", source_messages: [] }];
  const audit = auditGoldLeakage(tasks, taskRows, [{ tool: "get-record", content: "{\"unrelated\": true}" }], { "update-record": { required: ["note"] } });
  assert.equal(audit.status, "clean");
  assert.deepEqual(audit.findings, []);
  assert.equal(audit.checked_tasks, 1);
});

test("build-benchmark records the leakage audit additively in manifest.json", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-leakage-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const row = capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" });
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(row) + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  assert.equal(result.leakage_audit.schema_version, "understudy.leakage_audit.v1");
  assert.ok(["clean", "findings"].includes(result.leakage_audit.status));
  assert.ok(Array.isArray(result.leakage_audit.findings));
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.leakage_audit, result.leakage_audit);
  assert.equal(typeof result.leakage_audit.tier_counts, "object");
});

test("leakage audit fuzzy tier: shingle containment catches a restructured gold that verbatim misses", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const gold = "the quarterly rollback completed without any data loss across all seventeen regional replicas";
  const tasks = [{ task_id: "t-para", outcome_contract: { required: [
    { type: "response_obligation", kind: "contains_category", expected: gold },
  ], forbidden: [] } }];
  const taskRows = [{ task_id: "t-para", prompt: "Summarize the rollback status", system_prompt: "", source_messages: [] }];
  // Fixture paraphrases: reorders and inserts words so no 12+ char verbatim
  // normalized substring of ALL of the gold appears... actually verbatim
  // substring matching needs the WHOLE gold; here only fragments survive.
  const fixtures = [{ tool: "get-status", content: "Note: the quarterly rollback completed without any data loss (confirmed) across all seventeen regional replicas as of Friday." }];
  // The whole normalized gold is NOT a substring (the "(confirmed)" insertion
  // splits it) — tier 1 misses; most 5-gram shingles still match — tier 2a hits.
  const audit = auditGoldLeakage(tasks, taskRows, fixtures, {});
  assert.equal(audit.status, "advisory", "fuzzy-only findings are advisory, not alarms");
  assert.equal(audit.tier_counts.verbatim, 0);
  assert.equal(audit.tier_counts.fuzzy, 1);
  const finding = audit.findings[0];
  assert.equal(finding.tier, "fuzzy");
  assert.ok(finding.similarity >= 0.5 && finding.similarity <= 1);
  assert.match(finding.signal, /shingle containment/);
  assert.equal(finding.task_id, "t-para");
});

test("leakage audit fuzzy tier: number/entity fingerprints survive full paraphrase", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const gold = "Send the meeting summary for acct_401 totaling $12,450 to ops-review@example.com by 2026-08-01";
  const tasks = [{ task_id: "t-fp", outcome_contract: { required: [
    { type: "state_effect", tool: "send-summary", observed_arguments: { body: gold } },
  ], forbidden: [] } }];
  const taskRows = [{ task_id: "t-fp", prompt: "Handle the pending account follow-ups", system_prompt: "", source_messages: [] }];
  // Fully rewritten fixture text — zero shared 5-gram shingles — but the
  // account id, the amount (different thousands formatting), the email, and
  // the date all ride along.
  const fixtures = [{ tool: "get-notes", content: "Reminder: account acct_401 owes 12450 dollars; loop in ops-review@example.com before 2026-08-01." }];
  const audit = auditGoldLeakage(tasks, taskRows, fixtures, {});
  assert.equal(audit.status, "advisory");
  assert.equal(audit.tier_counts.fuzzy, 1);
  const finding = audit.findings[0];
  assert.equal(finding.tier, "fuzzy");
  assert.match(finding.signal, /fingerprint:/);
  assert.match(finding.signal, /acct_401/);
  assert.match(finding.signal, /12450/);
  assert.match(finding.signal, /ops-review@example\.com/);
  assert.equal(finding.similarity, 1, "all informative fingerprints leaked");
});

test("leakage audit fuzzy tier: benign guards — common words, input-carried entities, short numbers", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const tasks = [{ task_id: "t-benign", outcome_contract: { required: [
    // Common-word gold: shares vocabulary but no 5-gram run with the fixture.
    { type: "response_obligation", kind: "contains_category", expected: "please update the record status and confirm the change was saved correctly today" },
    // Entity gold whose id/date the PROMPT already carries — benign inputs.
    { type: "state_effect", tool: "update-record", observed_arguments: { note: "close ticket tick_9077 opened 2026-07-01 per policy" } },
    // Small numbers only (below the 5-digit fingerprint floor).
    { type: "state_effect", tool: "update-record", observed_arguments: { note: "set retries to 3 and timeout to 900 for env 42" } },
  ], forbidden: [] } }];
  const taskRows = [{ task_id: "t-benign", prompt: "Please close tick_9077 (opened 2026-07-01) following the standard procedure", system_prompt: "", source_messages: [] }];
  const fixtures = [{
    tool: "get-record",
    content: "The record was saved. Please confirm the status change today and update correctly. tick_9077 2026-07-01 retries 3 timeout 900 env 42",
  }];
  const audit = auditGoldLeakage(tasks, taskRows, fixtures, {});
  assert.equal(audit.status, "clean", `expected clean, got: ${JSON.stringify(audit.findings)}`);
  assert.deepEqual(audit.tier_counts, { verbatim: 0, fuzzy: 0, semantic: 0 });
});

test("leakage audit: verbatim finding keeps alarm status and subsumes fuzzy for the same surface; deterministic", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const gold = "confidential-report-Q3-final-9981 grand total 98765 dollars";
  const tasks = [{ task_id: "t-mix", outcome_contract: { required: [
    { type: "state_effect", tool: "update-record", observed_arguments: { document: gold } },
  ], forbidden: [] } }];
  const taskRows = [{ task_id: "t-mix", prompt: "Do the filing", system_prompt: "", source_messages: [] }];
  const fixtures = [{ tool: "get-record", content: gold }];
  const first = auditGoldLeakage(tasks, taskRows, fixtures, {});
  assert.equal(first.status, "findings", "verbatim hits keep the alarm status");
  assert.equal(first.tier_counts.verbatim, 1);
  assert.equal(first.tier_counts.fuzzy, 0, "no duplicate fuzzy finding for a verbatim-hit surface");
  assert.equal(first.findings[0].similarity, 1);
  // Deterministic: identical inputs → identical audit (byte-for-byte).
  const second = auditGoldLeakage(tasks, taskRows, fixtures, {});
  assert.deepEqual(second, first);
});

// ---------------------------------------------------------------------------
// Rollout state isolation: every rollout must start from the seeded initial
// world state. The generated world keeps ALL mutable state on the per-rollout
// WorldState (events / writes / used_fixtures via pydantic default_factory) —
// this test pins that guarantee by driving the REAL generated world.py twice
// with a stub verifiers.v1 module (the offline harness this repo supports;
// the pinned verifiers runtime instantiates a fresh WorldState per rollout).
// ---------------------------------------------------------------------------

// world.py uses PEP 604 annotations at module scope, so the driver needs
// python >= 3.10 (pydantic itself is stubbed below — no packages required).
const pythonBin = ["python3", "python3.13", "python3.12", "python3.11", "python3.14"].find(
  (bin) => spawnSync(bin, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], { encoding: "utf8" }).status === 0,
);

test("two sequential rollouts: rollout 2 starts from the seeded initial state, no residue from rollout 1", { skip: !pythonBin }, () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-isolation-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set synthetic record 7 active" }], { content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }], stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [{ role: "user", content: "Set synthetic record 7 active" }, { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "update-record", input: { id: 7, status: "active" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "{\"ok\":true,\"record\":7}" }] }], { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  // Stub verifiers.v1 + pydantic: just enough surface for world.py to import
  // and run — the point is to exercise the REAL generated world code, with
  // per-rollout instantiation exactly as the pinned verifiers runtime does it.
  const stub = join(root, "stub", "verifiers"); mkdirSync(stub, { recursive: true });
  writeFileSync(join(stub, "__init__.py"), "");
  writeFileSync(join(root, "stub", "pydantic.py"), [
    "import copy",
    "class _FieldMarker:",
    "    def __init__(self, default_factory=None): self.default_factory = default_factory",
    "def Field(default_factory=None, **kw): return _FieldMarker(default_factory)",
    "class BaseModel:",
    "    def __init__(self, **kw):",
    "        for k in dir(type(self)):",
    "            v = getattr(type(self), k)",
    "            if isinstance(v, _FieldMarker):",
    "                setattr(self, k, v.default_factory() if v.default_factory else None)",
    "        self.__dict__.update(kw)",
    "    def model_dump(self):",
    "        return copy.deepcopy(self.__dict__)  # snapshot, like real pydantic",
    "",
  ].join("\n"));
  writeFileSync(join(stub, "v1.py"), [
    "from typing import Generic, TypeVar",
    "from pydantic import BaseModel",
    "A = TypeVar('A'); B = TypeVar('B')",
    "class State(BaseModel): pass",
    "class ToolsetConfig(BaseModel): pass",
    "class Toolset(Generic[A, B]):",
    "    def __init__(self, state): self.state = state",
    "def tool(name=None):",
    "    def deco(fn): return fn",
    "    return deco",
    "",
  ].join("\n"));
  const driver = [
    "import asyncio, importlib.util, json, sys",
    `sys.path.insert(0, ${JSON.stringify(join(root, "stub"))})`,
    `spec = importlib.util.spec_from_file_location('world', ${JSON.stringify(join(output, "environment", "understudy_trace_env", "servers", "world.py"))})`,
    "world = importlib.util.module_from_spec(spec); spec.loader.exec_module(world)",
    "async def rollout():",
    "    # per-rollout env instantiation: fresh WorldState, exactly what the pinned verifiers runtime does",
    "    state = world.WorldState()",
    "    ts = world.WorldToolset(state)",
    "    initial = state.model_dump()",
    "    reply = await ts.update_record(id=7, status='active')",
    "    return initial, state.model_dump(), reply",
    "i1, f1, r1 = asyncio.run(rollout())",
    "i2, f2, r2 = asyncio.run(rollout())",
    "print(json.dumps({'initial1': i1, 'final1': f1, 'initial2': i2, 'final2': f2, 'reply1': r1, 'reply2': r2}))",
  ].join("\n");
  const proc = spawnSync(pythonBin, ["-c", driver], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout.trim().split("\n").at(-1));
  // Rollout 1 really mutated its world.
  assert.equal(out.final1.writes.length, 1, "rollout 1 performed a write");
  assert.ok(out.final1.events.length >= 1);
  // Rollout 2's INITIAL state is the seeded initial state — zero residue.
  assert.deepEqual(out.initial2, { events: [], writes: [], used_fixtures: [] }, "rollout 2 starts from the seeded initial world state");
  assert.deepEqual(out.initial2, out.initial1, "both rollouts start identically");
  // Fixture consumption restarts too: the first matching call in each rollout
  // gets the same seeded fixture reply, not a continuation of rollout 1's cursor.
  assert.equal(out.reply2, out.reply1, "fixture cursor resets per rollout");
  assert.deepEqual(out.final2.used_fixtures, out.final1.used_fixtures);
});

// ---------------------------------------------------------------------------
// OpenAI-format captures (warp-domain-identification regression suite):
// system prompt recovery, fence-tolerant JSON scoring (TS + generated python
// in lockstep), nodes-shaped _final_text, and honest filter buckets.
// ---------------------------------------------------------------------------

const openaiCapture = (id, ts, messages, text, extra = {}) => ({
  schema_version: 4, request_id: id, ts, workload_name: "domain-identification",
  customer_request_body: JSON.stringify({ model: "gpt-4o", messages, tools: [] }),
  response_body: JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
  status_code: 200, ...extra,
});

/** Stub verifiers.v1 + pydantic with enough surface to IMPORT the generated package (taskset.py + environment.py + world.py) — same offline-harness approach as the state-isolation test above. Returns the sys.path entry. */
function stubVerifiersV1(root) {
  const stub = join(root, "stub-taskset");
  mkdirSync(join(stub, "verifiers"), { recursive: true });
  writeFileSync(join(stub, "pydantic.py"), [
    "class _F:",
    "    def __init__(self, default_factory=None): self.default_factory = default_factory",
    "def Field(default_factory=None, **kw): return _F(default_factory)",
    "class BaseModel:",
    "    def __init__(self, **kw):",
    "        for k in dir(type(self)):",
    "            v = getattr(type(self), k)",
    "            if isinstance(v, _F): setattr(self, k, v.default_factory() if v.default_factory else None)",
    "        self.__dict__.update(kw)",
    "",
  ].join("\n"));
  writeFileSync(join(stub, "verifiers", "__init__.py"), "");
  writeFileSync(join(stub, "verifiers", "v1.py"), [
    "from typing import Generic, TypeVar",
    "from pydantic import BaseModel",
    "A = TypeVar('A'); B = TypeVar('B')",
    "class State(BaseModel): pass",
    "class ToolsetConfig(BaseModel): pass",
    "class TasksetConfig(BaseModel): pass",
    "class TaskData(BaseModel):",
    "    def __init__(self, **kw): self.__dict__.update(kw)",
    "class Trace: pass",
    "class Runtime: pass",  // annotation-only in taskset.py — but pre-3.14 pythons evaluate annotations at class-body time
    "class _Sub:",
    "    def __class_getitem__(cls, item): return cls",
    "class Task(_Sub, Generic[A, B]):",
    "    def __init__(self, *a, **k): pass",
    "class Taskset(_Sub, Generic[A, B]): pass",
    "class Toolset(_Sub, Generic[A, B]):",
    "    def __init__(self, state): self.state = state",
    "class HarnessConfig(BaseModel): pass",
    "class Harness(_Sub, Generic[A]):",
    "    def __init__(self, *a, **k): pass",
    "class EnvConfig(BaseModel): pass",
    "class Env:",
    "    def __init__(self, *a, **k): pass",
    "def load_taskset(c): return None",
    "def load_harness(c): return None",
    "def tool(name=None):",
    "    def deco(fn): return fn",
    "    return deco",
    "def stop(fn): return fn",
    "def reward(weight=1.0):",
    "    def deco(fn): return fn",
    "    return deco",
    "def metric(fn): return fn",
    "",
  ].join("\n"));
  return stub;
}

test("requestSystemPrompt: Anthropic request.system, OpenAI system/developer messages, multi-system join, absent", () => {
  assert.equal(requestSystemPrompt({ system: "anthropic sys", messages: [{ role: "system", content: "ignored" }] }), "anthropic sys");
  assert.equal(requestSystemPrompt({ messages: [{ role: "system", content: "openai sys" }, { role: "user", content: "q" }] }), "openai sys");
  assert.equal(requestSystemPrompt({ messages: [{ role: "developer", content: "dev sys" }, { role: "user", content: "q" }] }), "dev sys");
  assert.equal(
    requestSystemPrompt({ messages: [{ role: "system", content: "first" }, { role: "user", content: "q" }, { role: "system", content: "second" }] }),
    "first\n\nsecond",
  );
  assert.equal(requestSystemPrompt({ messages: [{ role: "system", content: [{ type: "text", text: "block sys" }] }] }), "block sys");
  assert.equal(requestSystemPrompt({ messages: [{ role: "user", content: "q" }] }), null);
  assert.equal(requestSystemPrompt(undefined), null);
});

test("OpenAI captures: environment tasks.json carries the system prompt from messages[0]", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-openai-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const rows = [
    openaiCapture("with-system", "2026-07-20T12:00:00Z",
      [{ role: "system", content: "You identify the primary domain. Respond with JSON." }, { role: "user", content: "Thread with bob@warp.dev — output JSON with conversationId and primaryDomain" }],
      '```json\n{"conversationId": "c1", "primaryDomain": "warp.dev"}\n```'),
    openaiCapture("without-system", "2026-07-20T12:05:00Z",
      [{ role: "user", content: "A totally different workload question with no system message at all" }],
      "plain text answer", { workload_name: "no-system-workload" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  const tasks = JSON.parse(readFileSync(join(output, "environment", "understudy_trace_env", "tasks.json"), "utf8"));
  const withSystem = tasks.find((t) => t.prompt.includes("bob@warp.dev"));
  assert.equal(withSystem.system_prompt, "You identify the primary domain. Respond with JSON.");
  const withoutSystem = tasks.find((t) => t.prompt.includes("no system message"));
  assert.equal(withoutSystem.system_prompt, null, "system-absent captures stay null (never a fabricated preamble)");
});

test("extractJsonPayload: fenced, bare, prose-wrapped, and non-JSON inputs (deterministic first-match)", () => {
  assert.deepEqual(extractJsonPayload('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonPayload('Here is the result:\n```json\n{"a": 1}\n```\nand also ```json\n{"b": 2}\n```'), { a: 1 });
  assert.deepEqual(extractJsonPayload('```\n{"plain": "fence"}\n```'), { plain: "fence" });
  assert.deepEqual(extractJsonPayload('{"bare": true}'), { bare: true });
  assert.deepEqual(extractJsonPayload('The answer is {"a": [1, 2], "s": "br{ace\\"}"} — done.'), { a: [1, 2], s: 'br{ace"}' });
  assert.deepEqual(extractJsonPayload('```json\n{broken\n```\nbut then {"ok": 1} in prose'), { ok: 1 });
  assert.equal(extractJsonPayload("no json here"), undefined);
  assert.equal(extractJsonPayload('"just a string"'), undefined);
  assert.equal(extractJsonPayload(null), undefined);
});

// Shared fixture strings for the TS↔python lockstep check.
const JSON_EXTRACTION_FIXTURES = [
  '```json\n{"conversationId": "c1", "primaryDomain": "warp.dev"}\n```',
  'Sure! Here is the classification:\n\n```json\n{"clean": true, "reasoning": "external party"}\n```\nLet me know if you need anything else.',
  '{"bare": ["object", 2]}',
  'prose first {"embedded": {"deep": "value"}} prose after',
  '```json\n{not json\n```\nfallback {"ok": 1}',
  "no json at all",
  '[1, 2, {"three": 3}]',
];

test("fenced-JSON scoring lockstep: generated taskset._extract_json matches extractJsonPayload on every fixture", { skip: !pythonBin }, () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-lockstep-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(openaiCapture("r1", "2026-07-20T12:00:00Z",
    [{ role: "system", content: "Classify." }, { role: "user", content: "Classify this thread into JSON" }], '```json\n{"clean": true}\n```')) + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  const env = join(output, "environment");
  const driver = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(stubVerifiersV1(root))})`,
    `sys.path.insert(0, ${JSON.stringify(env)})`,
    "import understudy_trace_env.taskset as ts",
    `fixtures = json.loads(${JSON.stringify(JSON.stringify(JSON_EXTRACTION_FIXTURES))})`,
    "print(json.dumps([ts._extract_json(f) for f in fixtures]))",
  ].join("\n");
  const proc = spawnSync(pythonBin, ["-c", driver], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  const python = JSON.parse(proc.stdout.trim().split("\n").at(-1));
  const ts = JSON_EXTRACTION_FIXTURES.map((f) => { const v = extractJsonPayload(f); return v === undefined ? null : v; });
  assert.deepEqual(python, ts, "python scorer and TS mirror must extract identical JSON from every fixture");
  assert.deepEqual(python[0], { conversationId: "c1", primaryDomain: "warp.dev" });
});

test("generated taskset._final_text walks verifiers v1 trace.nodes (objects AND dicts) and legacy shapes", { skip: !pythonBin }, () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-finaltext-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "captures.jsonl"), JSON.stringify(openaiCapture("r1", "2026-07-20T12:00:00Z",
    [{ role: "system", content: "Classify." }, { role: "user", content: "Classify this thread into JSON please" }], '{"clean": true}')) + "\n");
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  const env = join(output, "environment");
  const driver = [
    "import json, sys, types",
    `sys.path.insert(0, ${JSON.stringify(stubVerifiersV1(root))})`,
    `sys.path.insert(0, ${JSON.stringify(env)})`,
    "import understudy_trace_env.taskset as ts",
    "NS = types.SimpleNamespace",
    "# live verifiers v1 shape: trace.nodes is a list of OBJECTS, node.message an object",
    "live = NS(nodes=[",
    "    NS(message=NS(role='system', content='default coding-agent preamble')),",
    "    NS(message=NS(role='user', content='classify')),",
    "    NS(message=NS(role='assistant', content='')),",
    "    NS(message=NS(role='tool', content='{\"ok\": true}')),",
    "    NS(message=NS(role='assistant', content='```json\\n{\"clean\": true}\\n```')),",
    "])",
    "dict_nodes = NS(nodes=[{'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'hello'}, {'type': 'text', 'text': 'world'}]}}])",
    "legacy = NS(messages=[{'role': 'assistant', 'content': 'legacy text'}])",
    "empty = NS(nodes=[NS(message=NS(role='user', content='q'))])",
    "met = ts._entry_met({'type': 'response_obligation', 'kind': 'json_parses'}, [], ts._final_text(live))",
    "keys = ts._entry_met({'type': 'response_obligation', 'kind': 'schema_valid', 'expected_keys': ['clean']}, [], ts._final_text(live))",
    "print(json.dumps({'live': ts._final_text(live), 'dict': ts._final_text(dict_nodes), 'legacy': ts._final_text(legacy), 'empty': ts._final_text(empty), 'json_parses': met, 'schema_valid': keys}))",
  ].join("\n");
  const proc = spawnSync(pythonBin, ["-c", driver], { encoding: "utf8" });
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout.trim().split("\n").at(-1));
  assert.equal(out.live, '```json\n{"clean": true}\n```', "last assistant text from object-shaped nodes");
  assert.equal(out.dict, "hello world", "dict-shaped nodes with text blocks");
  assert.equal(out.legacy, "legacy text", "legacy messages fallback still works");
  assert.equal(out.empty, "", "no assistant text = empty string, never a crash");
  assert.equal(out.json_parses, true, "response obligation json_parses now passes live (fenced output, nodes shape)");
  assert.equal(out.schema_valid, true, "response obligation schema_valid now passes live");
});

test("filter buckets: non-normalizable captures are split into honest reasons (old key kept for compat)", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-buckets-"));
  const source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const good = openaiCapture("good", "2026-07-20T12:00:00Z", [{ role: "user", content: "hello there classify me" }], "ok");
  const missingTs = { ...openaiCapture("missing", "x", [{ role: "user", content: "y" }], "z") };
  delete missingTs.ts;
  const malformedTs = openaiCapture("malformed", "not-a-date", [{ role: "user", content: "y" }], "z");
  writeFileSync(join(source, "captures.jsonl"), [good, missingTs, malformedTs].map(JSON.stringify).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  assert.equal(result.counts.not_normalizable_filtered, 2);
  assert.deepEqual(result.counts.filtered_reasons, { missing_timestamp: 1, malformed_timestamp: 1 });
  assert.equal(result.counts.invalid_timestamp_filtered, 2, "compat: legacy key stays populated with the total");
  assert.equal(result.counts.captures, 1);
});
