import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileTraceFoundry, regenerateEnvironment, splitTaskObservations } from "../dist/trace-foundry.js";

const capture = (id, ts, messages, response) => ({
  schema_version: 4, request_id: id, ts, workload_name: "synthetic-automation",
  customer_request_body: JSON.stringify({ system: "Operate a synthetic project board.", messages, tools: [{ name: "update-record", input_schema: { type: "object" } }] }),
  response_body: JSON.stringify(response), status_code: 200,
});

// ---------------------------------------------------------------------------
// Fixtures-state-split: fixtures.json is candidate-readable and must carry
// ONLY pre-state (what the incumbent observed before its first gold write);
// expected post-state moves to scorer-side environment/gold.json.
// ---------------------------------------------------------------------------

test("environment generation splits pre-state fixtures from scorer-side post-state gold", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-split-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  const gold = "quarterly-deal-overview-rewrite-gold-991182";
  const rows = [
    capture("round-1", "2026-07-20T12:00:00Z", [
      { role: "user", content: "Refresh the overview for record 7" },
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 7 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "{\"id\":7,\"summary\":\"the stale pre-state summary text\"}" }] },
    ], { content: [{ type: "tool_use", id: "w1", name: "update-record", input: { id: 7, summary: gold } }], stop_reason: "tool_use" }),
    capture("round-2", "2026-07-20T12:00:01Z", [
      { role: "user", content: "Refresh the overview for record 7" },
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 7 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "{\"id\":7,\"summary\":\"the stale pre-state summary text\"}" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "update-record", input: { id: 7, summary: gold } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: `{\"ok\":true,\"summary\":\"${gold}\"}` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "get-record", input: { id: 7 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r2", content: `{\"id\":7,\"summary\":\"${gold}\"}` }] },
    ], { content: [{ type: "text", text: "Overview refreshed." }], stop_reason: "end_turn" }),
  ];
  writeFileSync(join(source, "captures.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const result = compileTraceFoundry(source, output, 3, new Date("2026-07-21T12:00:00Z"));
  const fixturesText = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "fixtures.json"), "utf8");
  const fixtures = JSON.parse(fixturesText);
  assert.ok(fixtures.some((f) => f.tool === "get-record" && String(f.content).includes("stale pre-state")), "pre-write read is served as a fixture");
  assert.ok(!fixturesText.includes(gold), "gold post-state value never appears in candidate-readable fixtures.json");
  const goldFile = JSON.parse(readFileSync(join(output, "environment", "gold.json"), "utf8"));
  assert.equal(goldFile.schema_version, "understudy.environment_gold.v1");
  const post = goldFile.tasks.flatMap((t) => t.post_state_observations);
  assert.ok(post.some((o) => String(o.content).includes(gold)), "post-state observations moved to scorer-side gold.json");
  assert.ok(post.some((o) => o.tool === "update-record"), "the write's own echo is post-state");
  assert.ok(post.some((o) => o.tool === "get-record"), "the post-write re-read is post-state");
  // Audit drop: the gold existed ONLY as post-state — post-split the audit records no verbatim finding for it.
  assert.ok(!result.leakage_audit.findings.some((f) => f.excerpt.includes(gold)), "leakage audit no longer flags the split-out gold");
  assert.equal(result.fixtures_split.layout, "prestate_only.v1");
  assert.match(readFileSync(join(output, "environment", "README.md"), "utf8"), /gold\.json/);
  // world.py never references gold.json.
  assert.doesNotMatch(readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8"), /gold\.json/);
});

test("fixtures are task-scoped: another task's pre-state echoing this task's gold is unreachable and not a finding", async () => {
  const { auditGoldLeakage } = await import("../dist/trace-foundry.js");
  const gold = "the-deal-overview-gold-string-9911";
  const tasks = [{ task_id: "task-a", outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { overview: gold } }], forbidden: [] } }];
  const taskRows = [{ task_id: "task-a", prompt: "Update the overview", system_prompt: "", source_messages: [] }];
  // task-b ran LATER on the same object; its pre-state read echoes task-a's gold. The world
  // never serves task-b's fixtures to a task-a rollout, so this is NOT a finding for task-a.
  const scoped = auditGoldLeakage(tasks, taskRows, [{ task_id: "task-b", tool: "get-record", content: `{"overview":"${gold}"}` }], {});
  assert.equal(scoped.status, "clean");
  // An UNTAGGED (old-layout) fixture is served to every task — still a finding.
  const untagged = auditGoldLeakage(tasks, taskRows, [{ tool: "get-record", content: `{"overview":"${gold}"}` }], {});
  assert.equal(untagged.status, "findings");
  // The task's OWN fixture carrying the gold is still a finding (read-to-write overlaps surface as advisories for a human).
  const own = auditGoldLeakage(tasks, taskRows, [{ task_id: "task-a", tool: "get-record", content: `{"overview":"${gold}"}` }], {});
  assert.equal(own.status, "findings");
});

test("generated world scopes fixture serving per task via setup_task", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-scoped-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [
    { role: "user", content: "Create it" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "{\"id\":1}" }] },
  ], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1 } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  const world = readFileSync(join(output, "environment", "understudy_trace_env", "servers", "world.py"), "utf8");
  assert.match(world, /async def setup_task\(self, task\)/);
  assert.match(world, /_task_fixtures/);
  assert.match(world, /fixture\.get\("task_id"\) in \(None, task_id\)/, "untagged old-layout fixtures stay servable to every task");
  const fixtures = JSON.parse(readFileSync(join(output, "environment", "understudy_trace_env", "servers", "fixtures.json"), "utf8"));
  assert.ok(fixtures.length > 0 && fixtures.every((f) => typeof f.task_id === "string"), "every generated fixture is task-tagged");
});

test("splitTaskObservations: capture-less fallback cuts at the first mutating result; event path handles a missing write echo", () => {
  const task = { task_id: "t", source: { node_ids: [] }, world_model: { initial_state: { observations: [
    { tool: "get-record", arguments: { id: 1 }, content: "pre" },
    { tool: "update-record", arguments: { id: 1 }, content: "write echo" },
    { tool: "get-record", arguments: { id: 1 }, content: "post" },
  ] } } };
  const fallback = splitTaskObservations(task);
  assert.deepEqual(fallback.pre.map((o) => o.content), ["pre"]);
  assert.deepEqual(fallback.post.map((o) => o.content), ["write echo", "post"]);
  // Event path: the mutating CALL bounds the split even when its result was never captured.
  const row = {
    capture_key: "k1",
    request: { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "pre" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "update-record", input: { id: 1 } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "r2", name: "get-record", input: { id: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "r2", content: "post" }] },
    ] },
    response: {},
  };
  const withCaptures = splitTaskObservations({ ...task, source: { node_ids: ["k1"] } }, new Map([["k1", row]]));
  assert.deepEqual(withCaptures.pre.map((o) => o.content), ["pre"]);
  assert.deepEqual(withCaptures.post.map((o) => o.content), ["post"]);
});

test("regenerate-env tolerates old-layout environments (no gold.json) and rebuilds them into the split layout", () => {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-oldlayout-")), source = join(root, "captures"), output = join(root, "out"); mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "one.json"), JSON.stringify(capture("one", "2026-07-20T00:00:00Z", [
    { role: "user", content: "Create it" },
    { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "get-record", input: { id: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "{\"id\":1}" }] },
  ], { content: [{ type: "tool_use", id: "x", name: "update-record", input: { id: 1 } }] })));
  compileTraceFoundry(source, output, 3, new Date("2026-07-21T00:00:00Z"));
  // Simulate a pre-split environment: no gold.json, no README.
  rmSync(join(output, "environment", "gold.json"));
  rmSync(join(output, "environment", "README.md"));
  const result = regenerateEnvironment(output);
  assert.equal(result.oracle_pass, true);
  assert.ok(existsSync(join(output, "environment", "gold.json")), "regenerate writes the split layout");
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.fixtures_split.layout, "prestate_only.v1");
});
