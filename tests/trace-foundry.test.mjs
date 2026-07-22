import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { compileTraceFoundry, createTraceReplayPlan, importTraceReviews, runTraceReplays } from "../dist/trace-foundry.js";
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
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [{ role: "user", content: "Create it" }], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1, status: "active" } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const task = JSON.parse(readFileSync(join(output, "tasks.jsonl"), "utf8"));
  task.outcome_contract.required.push({ type: "response_obligation", kind: "contains_category", expected: "done" });
  assert.equal(refreshOfflineValidation(output, [task]), true);
  const validation = JSON.parse(readFileSync(join(output, "environment", "offline-validation.json"), "utf8"));
  const row = validation.tasks.find((r) => r.task_id === task.task_id);
  assert.equal(row.oracle.strict, 1);
  assert.equal(row.oracle.met.length, 2, "refreshed row scores the widened contract");
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
