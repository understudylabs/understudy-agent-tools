import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorOverview,
  complexityLabel,
  digestCapture,
  groupTasksByAuthoredCategory,
  markComplexityFrontier,
  systemPromptClusters,
  taskComplexityMetrics,
  toolUsageTable,
} from "../dist/trace-author.js";

// ---- synthetic fixtures only: no customer data --------------------------

const task = (id, categoryId, authored = true) => ({
  schema_version: "understudy.benchmark_task.v1",
  task_id: id,
  title: `machine title for ${id}`,
  tool_surface: ["update-record", "send-email"],
  outcome_contract: { required: [{ tool: "update-record", observed_arguments: { id: 1 } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
  authored: authored
    ? {
        schema_version: "understudy.task_authoring.v1",
        intent_summary: `Do the ${categoryId} thing for ${id}.`,
        statement: `A synthetic ${categoryId} task.`,
        success_criteria: [`The ${categoryId} record ends updated.`],
        category_proposal: { id: categoryId, name: categoryId },
      }
    : null,
});

function benchmarkDir(tasks) {
  const dir = mkdtempSync(join(tmpdir(), "understudy-overview-"));
  writeFileSync(join(dir, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  return dir;
}

const fakeClient = (replies) => {
  const calls = [];
  const client = async (request) => {
    calls.push(request);
    const system = request.messages[0].content;
    const reply = system.includes("workload_summary")
      ? { workload_summary: "A synthetic record-updating workload." }
      : { archetype_title: "Record updates", archetype_description: "The agent updates a record and mails a notice." };
    return { content: JSON.stringify(typeof replies === "function" ? replies(request) ?? reply : reply), usage: { prompt_tokens: 500, completion_tokens: 100 } };
  };
  client.calls = calls;
  return client;
};

test("groupTasksByAuthoredCategory groups by authored category id, pooling unauthored tasks", () => {
  const groups = groupTasksByAuthoredCategory([task("t1", "alpha"), task("t2", "alpha"), task("t3", "beta"), task("t4", "x", false)]);
  assert.deepEqual([...groups.keys()].sort(), ["alpha", "beta", "uncategorized"]);
  assert.equal(groups.get("alpha").length, 2);
  assert.equal(groups.get("uncategorized")[0].task_id, "t4");
});

test("authorOverview makes 1 + categories calls and writes understudy.benchmark_overview.v1", async () => {
  const dir = benchmarkDir([task("t1", "alpha"), task("t2", "alpha"), task("t3", "beta")]);
  const client = fakeClient();
  const result = await authorOverview(dir, { model: "test-model", client, now: new Date("2026-07-21T00:00:00Z") });
  assert.equal(client.calls.length, 3); // 1 summary + 2 categories
  assert.equal(result.calls, 3);
  assert.ok(existsSync(join(dir, "benchmark-overview.json")));
  const overview = JSON.parse(readFileSync(join(dir, "benchmark-overview.json"), "utf8"));
  assert.equal(overview.schema_version, "understudy.benchmark_overview.v1");
  assert.equal(overview.model, "test-model");
  assert.equal(overview.workload_summary, "A synthetic record-updating workload.");
  assert.equal(overview.categories.length, 2);
  const alpha = overview.categories.find((c) => c.category_id === "alpha");
  assert.equal(alpha.archetype_title, "Record updates");
  assert.deepEqual(alpha.representative_task_ids, ["t1", "t2"]); // deterministic, no LLM
  assert.equal(alpha.task_count, 2);
  // Grounding of the evidence sent to the model: authored intents, never raw payloads.
  const categoryCall = client.calls[1].messages[1].content;
  assert.ok(categoryCall.includes("Do the alpha thing"));
  // The pass is audited like every authoring call.
  const events = readFileSync(join(dir, "authoring-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.at(-1).kind, "overview");
  assert.equal(events.at(-1).calls, 3);
});

test("authorOverview survives unparseable model output with null narrative fields", async () => {
  const dir = benchmarkDir([task("t1", "alpha")]);
  const client = async () => ({ content: "not json at all", usage: {} });
  const result = await authorOverview(dir, { model: "test-model", client });
  assert.equal(result.overview.workload_summary, null);
  assert.equal(result.overview.categories[0].archetype_title, null);
  assert.deepEqual(result.overview.categories[0].representative_task_ids, ["t1"]);
});

test("authorOverview caps representative task ids", async () => {
  const tasks = Array.from({ length: 9 }, (_, i) => task(`t${i}`, "alpha"));
  const dir = benchmarkDir(tasks);
  const result = await authorOverview(dir, { model: "test-model", client: fakeClient(), representativeLimit: 4 });
  assert.equal(result.overview.categories[0].representative_task_ids.length, 4);
  assert.equal(result.overview.categories[0].task_count, 9);
});

/* ---- deterministic layer ---- */

test("systemPromptClusters collapses id-varying prompts into one canonical cluster", () => {
  const digests = [
    { system: "You manage conversation/1980f239-2073-4231-9d5c-3174fe334214/ for user a@example.com." },
    { system: "You manage conversation/47aaf4ad-7d8c-4416-95a8-1cfcd3403ad1/ for user b@example.com." },
    { system: "A completely different prompt about weather reports." },
    { system: "" }, // empty prompts don't count toward coverage
  ];
  const clusters = systemPromptClusters(digests);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 2);
  assert.equal(clusters[0].coverage, 0.667);
  assert.ok(clusters[0].representative_excerpt.includes("You manage conversation/"));
  assert.equal(clusters[1].count, 1);
});

test("toolUsageTable reports defined-vs-called with prefix-round dedupe", () => {
  const tasks = [task("t1", "alpha")]; // defines update-record + send-email
  const call = { id: "c1", name: "update-record", arguments: { id: 7 } };
  const digests = [
    { capture_key: "k1", chars: 10, message_count: 1, calls: [call], system: "s" },
    { capture_key: "k2", chars: 20, message_count: 3, calls: [call, { id: "c2", name: "lookup-record", arguments: {} }], system: "s" },
  ];
  const table = toolUsageTable(tasks, digests);
  assert.deepEqual(table, [
    { tool: "lookup-record", defined: false, calls: 1 },
    { tool: "send-email", defined: true, calls: 0 },
    { tool: "update-record", defined: true, calls: 1 }, // c1 deduped across rounds
  ]);
});

test("taskComplexityMetrics measures the fullest round and flags the frontier", () => {
  const mkTask = (id, nodeIds, edges = []) => ({ ...task(id, "alpha"), source: { node_ids: nodeIds, edges } });
  const digest = (key, chars, messages, calls) => ({
    capture_key: key,
    chars,
    message_count: messages,
    calls: calls.map((n, i) => ({ id: `${key}-${i}`, name: n, arguments: {} })),
    system: "s",
  });
  const digests = new Map(
    [
      digest("a1", 400, 2, ["update-record"]),
      digest("b1", 400, 2, ["update-record"]),
      digest("c1", 160000, 9, ["update-record", "send-email", "lookup-record", "send-email"]),
    ].map((d) => [d.capture_key, d]),
  );
  const tasks = [
    mkTask("small-1", ["a1"]),
    mkTask("small-2", ["b1"]),
    mkTask("big", ["c1"], [{ from: "x", to: "y", type: "retry" }, { from: "y", to: "z", type: "prefix_append" }]),
  ];
  const metrics = taskComplexityMetrics(tasks, digests);
  const big = metrics.get("big");
  assert.equal(big.approx_context_tokens, 40000);
  assert.equal(big.turn_count, 9);
  assert.equal(big.tool_call_count, 4);
  assert.equal(big.distinct_tools, 3);
  assert.equal(big.error_retry_events, 1); // prefix_append is not an error event
  assert.equal(big.frontier, true);
  assert.ok(big.frontier_axes.includes("approx_context_tokens"));
  assert.equal(metrics.get("small-1").frontier, false);
  assert.equal(complexityLabel(big), "9 turns · 4 tool calls · ~40k ctx");
});

test("markComplexityFrontier flags nobody on all-equal axes", () => {
  const m = (v) => ({ approx_context_tokens: v, turn_count: v, tool_call_count: v, distinct_tools: v, error_retry_events: v, frontier: false, frontier_axes: [] });
  const metrics = markComplexityFrontier(new Map([["a", m(5)], ["b", m(5)], ["c", m(5)]]));
  assert.ok([...metrics.values()].every((x) => x.frontier === false));
});

test("digestCapture derives chars, turns, calls and system from a normalized capture", () => {
  const d = digestCapture({
    capture_key: "k",
    request: { system: "You do things.", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "tool_use", id: "c9", name: "update-record", input: { id: 1 } }] }] },
    response: { tool_calls: [{ id: "c10", function: { name: "send-email", arguments: "{\"to\":\"x\"}" } }] },
  });
  assert.equal(d.capture_key, "k");
  assert.equal(d.message_count, 2);
  assert.deepEqual(d.calls.map((c) => c.name).sort(), ["send-email", "update-record"]);
  assert.equal(d.system, "You do things.");
  assert.ok(d.chars > 0);
});

test("authorOverview stores the deterministic layer and grounds the summary call in it", async () => {
  const dir = benchmarkDir([task("t1", "alpha")]);
  writeFileSync(
    join(dir, "normalized-captures.jsonl"),
    JSON.stringify({
      capture_key: "n1",
      request: { system: "You operate the synthetic alpha workload.", messages: [{ role: "user", content: "go" }] },
      response: { tool_calls: [{ id: "c1", function: { name: "update-record", arguments: "{}" } }] },
    }) + "\n",
  );
  const client = fakeClient();
  const result = await authorOverview(dir, { model: "test-model", client });
  const overview = result.overview;
  assert.equal(overview.system_prompt_clusters.length, 1);
  assert.equal(overview.system_prompt_clusters[0].coverage, 1);
  assert.ok(overview.tool_usage.some((r) => r.tool === "update-record" && r.calls === 1 && r.defined === true));
  assert.ok(overview.task_complexity.t1);
  assert.equal(typeof overview.task_complexity.t1.approx_context_tokens, "number");
  // The summary call's evidence carries the deterministic layer, not raw payloads.
  const summaryEvidence = client.calls[0].messages[1].content;
  assert.ok(summaryEvidence.includes("system_prompt_clusters"));
  assert.ok(summaryEvidence.includes("tool_usage"));
  assert.ok(summaryEvidence.includes("You operate the synthetic alpha workload."));
});

test("authorOverview refuses an empty benchmark dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "understudy-overview-empty-"));
  await assert.rejects(() => authorOverview(dir, { model: "m", client: fakeClient() }), /No tasks\.jsonl/);
});
