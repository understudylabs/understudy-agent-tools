import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Real in-tree foundry builds the proposed fixture, like proposed.test.mjs.
import { compileTraceFoundry } from "../../../dist/trace-foundry.js";
import {
  aggregatePromotedTasks,
  binHistogram,
  captureRolloutMeta,
  conversationFromCapture,
  dedupSystem,
  divergenceMarkers,
  entitySegments,
  spineRoundIndex,
  firstLine,
  scoreColor,
} from "./.build/lib/trajectory-core.js";
import { GET as capturesGET } from "./.build/app/api/captures/route.js";
import { getEntry, taskProvenance } from "./.build/lib/data-core.js";
import { GET as rolloutsGET } from "./.build/app/api/rollouts/route.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-trajectory-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("binHistogram", () => {
  it("bins values into fixed-width buckets with min/max", () => {
    const h = binHistogram([0, 0.1, 0.5, 0.9, 1, 1], 4);
    assert.equal(h.count, 6);
    assert.equal(h.min, 0);
    assert.equal(h.max, 1);
    assert.equal(h.bins.length, 4);
    assert.equal(h.bins.reduce((a, b) => a + b, 0), 6);
    assert.equal(h.bins[3], 3); // 0.9, 1, 1 land in the last bucket
  });
  it("stays renderable on empty and single-value inputs", () => {
    assert.equal(binHistogram([], 5).count, 0);
    assert.deepEqual(binHistogram([], 5).bins, [0, 0, 0, 0, 0]);
    const single = binHistogram([0.7, null, undefined], 5);
    assert.equal(single.count, 1);
    assert.equal(single.bins[0], 1);
  });
});

describe("snippets + entity chips", () => {
  it("firstLine takes the first non-empty line, clipped", () => {
    assert.equal(firstLine("\n\n  hello world  \nsecond"), "hello world");
    assert.equal(firstLine("x".repeat(200), 20).length, 20);
    assert.ok(firstLine("x".repeat(200), 20).endsWith("…"));
  });
  it("entitySegments chips long ids, emails and phone-shaped strings", () => {
    const segs = entitySegments("Update 003xx000004TmiU then email kendall@example.com or call +1 (415) 555-0100.");
    const entities = segs.filter((s) => s.kind === "entity").map((s) => s.value);
    assert.ok(entities.includes("003xx000004TmiU"));
    assert.ok(entities.includes("kendall@example.com"));
    assert.ok(entities.some((e) => e.includes("415")));
    assert.equal(segs.map((s) => s.value).join(""), "Update 003xx000004TmiU then email kendall@example.com or call +1 (415) 555-0100.");
  });
  it("leaves plain prose un-chipped", () => {
    const segs = entitySegments("Close a won deal and notify the owning team.");
    assert.deepEqual(segs, [{ kind: "text", value: "Close a won deal and notify the owning team." }]);
  });
});

describe("conversationFromCapture", () => {
  const body = {
    request: {
      system: "Operate a synthetic board.",
      messages: [
        { role: "user", content: "Set record 7 active" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] },
      ],
      tools: [{ name: "update-record" }],
    },
    response: { encoding: "json", body: { content: [{ type: "text", text: "Done" }] }, tool_calls: [], stop_reason: "end_turn" },
  };
  it("demotes system, normalizes turns, chips tool calls and outputs", () => {
    const conv = conversationFromCapture(body);
    assert.equal(conv.system, "Operate a synthetic board.");
    assert.equal(conv.turns.length, 4); // 3 request turns + response assistant turn
    assert.equal(conv.turns[1].chips[0].kind, "call");
    assert.equal(conv.turns[1].chips[0].name, "update-record");
    assert.equal(conv.turns[2].chips[0].kind, "output");
    assert.equal(conv.turns[3].role, "assistant");
    assert.equal(conv.turns[3].text, "Done");
    assert.deepEqual(conv.toolNames, ["update-record"]);
  });
  it("reassembles SSE streamed responses and parses stringified tool arguments", () => {
    const conv = conversationFromCapture({
      request: { messages: [{ role: "user", content: "go" }] },
      response: {
        encoding: "sse",
        events: [{ delta: { text: "Hel" } }, { choices: [{ delta: { content: "lo" } }] }],
        tool_calls: [{ id: "t1", function: { name: "api_search", arguments: '{"query":"deals"}' } }],
      },
    });
    const last = conv.turns[conv.turns.length - 1];
    assert.equal(last.text, "Hello");
    assert.deepEqual(last.chips[0], { kind: "call", name: "api_search", id: "t1", payload: { query: "deals" } });
  });
  it("captureRolloutMeta derives snippet + counts + workload", () => {
    const meta = captureRolloutMeta("cap-1", { ...body, captured_at: "2026-07-20T12:00:00Z", scope: { workload_name: "board-ops" } });
    assert.equal(meta.snippet, "Set record 7 active");
    assert.equal(meta.messageCount, 4);
    assert.equal(meta.toolCallCount, 1);
    assert.equal(meta.workload, "board-ops");
    assert.equal(meta.capturedAt, "2026-07-20T12:00:00Z");
  });
});

describe("dedupSystem", () => {
  it("surfaces the first non-empty system prompt once and flags divergence", () => {
    assert.deepEqual(dedupSystem([null, "A", "A"]), { system: "A", diverged: false });
    assert.deepEqual(dedupSystem(["A", "B"]), { system: "A", diverged: true });
    assert.deepEqual(dedupSystem([null, ""]), { system: null, diverged: false });
  });
});

describe("aggregatePromotedTasks (rollout grouping)", () => {
  const tasks = [{ task_id: "t1" }, { task_id: "t2" }];
  const rows = [
    { task_id: "t1", score: 1, status: "ok" },
    { task_id: "t1", score: 0, status: "ok" },
    { task_id: "t1", score: null, status: "error" },
    { task_id: "t2", score: 0.5, status: "ok" },
  ];
  it("counts every row as a rollout but averages only scored ok rows", () => {
    const agg = aggregatePromotedTasks(tasks, rows, { t1: "Rename the store" }, { t1: 42 });
    assert.equal(agg[0].rollouts, 3);
    assert.equal(agg[0].avgScore, 0.5);
    assert.equal(agg[0].displayName, "Rename the store");
    assert.equal(agg[0].promptLength, 42);
    assert.equal(agg[1].rollouts, 1);
    assert.equal(agg[1].avgScore, 0.5);
    assert.equal(agg[1].displayName, "t2");
  });
  it("tasks without rows keep a null average", () => {
    const agg = aggregatePromotedTasks([{ task_id: "t3" }], []);
    assert.equal(agg[0].rollouts, 0);
    assert.equal(agg[0].avgScore, null);
  });
});

describe("scoreColor", () => {
  it("maps score bands to contract viz tokens only", () => {
    assert.equal(scoreColor(null), "var(--muted-foreground)");
    assert.equal(scoreColor(0.9), "var(--viz-series-3)");
    assert.equal(scoreColor(0.6), "var(--viz-series-2)");
    assert.equal(scoreColor(0.1), "var(--destructive)");
  });
});

/* ---- /api/captures meta mode over a real foundry output ---- */

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
compileTraceFoundry(source, path.join(tmp, "trajectory-demo"), 36500, new Date("2026-07-21T12:00:00Z"));

describe("GET /api/captures meta mode", () => {
  const slug = "data--trajectory-demo";
  const taskId = () => {
    const tasks = fs
      .readFileSync(path.join(tmp, "trajectory-demo", "tasks.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return tasks[0].task_id;
  };
  it("lists the task's rounds with snippet, counts and provenance", async () => {
    const res = await capturesGET(
      new Request(`http://x/api/captures?slug=${slug}&task=${encodeURIComponent(taskId())}&meta=1`),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.rounds.length >= 1);
    const round = body.rounds[0];
    assert.equal(round.snippet, "Set record 7 active");
    assert.ok(round.sha256.length > 0);
    assert.equal(round.body_missing, false);
    assert.ok(round.message_count >= 1);
  });
  it("404s on an unknown task id", async () => {
    const res = await capturesGET(new Request(`http://x/api/captures?slug=${slug}&task=nope&meta=1`));
    assert.equal(res.status, 404);
  });
  it("still requires id when meta mode is not requested", async () => {
    const res = await capturesGET(new Request(`http://x/api/captures?slug=${slug}`));
    assert.equal(res.status, 400);
  });
  it("returns the task's source-DAG edges for divergence markers", async () => {
    const res = await capturesGET(
      new Request(`http://x/api/captures?slug=${slug}&task=${encodeURIComponent(taskId())}&meta=1`),
    );
    const body = await res.json();
    assert.ok(Array.isArray(body.edges));
    for (const e of body.edges) {
      assert.equal(typeof e.type, "string");
      assert.ok("common_prefix_messages" in e);
    }
  });
});

describe("taskProvenance (compact rail disclosure)", () => {
  it("counts captures and collects distinct workloads/trace ids from the task's bodies", () => {
    const entry = getEntry("data--trajectory-demo");
    assert.equal(entry.kind, "proposed");
    const prov = taskProvenance(entry, entry.tasks[0]);
    assert.ok(prov.captureCount >= 1);
    assert.ok(Array.isArray(prov.workloads));
    assert.ok(Array.isArray(prov.traceIds));
  });
});

describe("benchmark-overview.json loading", () => {
  it("loads understudy.benchmark_overview.v1 onto the proposed entry, ignoring wrong schemas", () => {
    const dir = path.join(tmp, "trajectory-demo");
    const file = path.join(dir, "benchmark-overview.json");
    fs.writeFileSync(file, JSON.stringify({ schema_version: "wrong", categories: [] }));
    assert.equal(getEntry("data--trajectory-demo").overview, null);
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema_version: "understudy.benchmark_overview.v1",
        model: "test-model",
        workload_summary: "A synthetic workload.",
        categories: [{ category_id: "alpha", archetype_title: "T", archetype_description: "D", representative_task_ids: [] }],
      }),
    );
    const entry = getEntry("data--trajectory-demo");
    assert.equal(entry.overview.workload_summary, "A synthetic workload.");
    assert.equal(entry.overview.categories[0].category_id, "alpha");
    fs.rmSync(file);
  });
});

describe("flattened trajectory (spine + divergence markers)", () => {
  it("picks the LAST round with a body as the spine", () => {
    assert.equal(spineRoundIndex([{ body_missing: false }, { body_missing: false }]), 1);
    assert.equal(spineRoundIndex([{ body_missing: false }, { body_missing: true }]), 0);
    assert.equal(spineRoundIndex([{ body_missing: true }, { body_missing: true }]), 1);
    assert.equal(spineRoundIndex([]), -1 + 0); // degenerate: no rounds
  });
  it("emits no markers for pure prefix-append chains", () => {
    const edges = [
      { from: "a", to: "b", type: "prefix_append", common_prefix_messages: 1 },
      { from: "b", to: "c", type: "prefix_append", common_prefix_messages: 3 },
    ];
    assert.deepEqual(divergenceMarkers(edges, 10), []);
  });
  it("marks retries and branches at the divergence turn, sorted and deduped", () => {
    const edges = [
      { from: "b", to: "d", type: "branch", common_prefix_messages: 5 },
      { from: "a", to: "b", type: "retry", common_prefix_messages: 2 },
      { from: "a", to: "c", type: "retry", common_prefix_messages: 2 }, // dupe point+label
      { from: "c", to: "e", type: "same_depth_mutation", common_prefix_messages: null },
    ];
    const markers = divergenceMarkers(edges, 8);
    assert.deepEqual(
      markers.map((m) => [m.turnIndex, m.label]),
      [
        [2, "retried from here"],
        [5, "branch"],
        [8, "edited in place"], // null prefix clamps to end of stream
      ],
    );
  });
  it("clamps marker positions into the spine's turn range", () => {
    const markers = divergenceMarkers([{ from: "a", to: "b", type: "retry", common_prefix_messages: 99 }], 4);
    assert.deepEqual(markers.map((m) => m.turnIndex), [4]);
  });
});

/* ---- /api/rollouts over a promoted fixture ---- */

const promotedDir = path.join(tmp, "promoted-demo");
fs.mkdirSync(promotedDir, { recursive: true });
fs.writeFileSync(
  path.join(promotedDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "promoted-demo",
    provenance: { origin: "derived-from-traces" },
    taxonomy: [{ category_id: "cat-1" }],
    tasks: [{ task_id: "task-1", category_id: "cat-1", genesis: "replayed", split: "holdout", gold: { kind: "final-state", ref: "g" } }],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
  }),
);
fs.writeFileSync(
  path.join(promotedDir, "rows-run.jsonl"),
  [
    {
      schema_version: "understudy.eval_result.v1",
      run_id: "run-a",
      task_id: "task-1",
      score: 1,
      status: "ok",
      model: "gemma",
      subscores: { partial_credit: 1 },
      trace_ref: { branch_leaf: "n4", branch_depth: 4 },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
fs.writeFileSync(
  path.join(promotedDir, "traces.jsonl"),
  [
    { id: "n1", parents: [], task_id: "task-1", role: "system", content: "You are an agent." },
    { id: "n2", parents: ["n1"], task_id: "task-1", role: "user", content: "Rename UserStore." },
    { id: "n3", parents: ["n2"], task_id: "task-1", role: "assistant", content: "Renaming." },
    { id: "n4", parents: ["n3"], task_id: "task-1", role: "tool", content: "ok", reward: 1 },
    { id: "n3b", parents: ["n2"], task_id: "task-1", role: "assistant", content: "Alt branch.", reward: 0 },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);

describe("GET /api/rollouts", () => {
  it("joins eval rows to trace branches and demotes the system turn", async () => {
    const res = await rolloutsGET(new Request("http://x/api/rollouts?slug=data--promoted-demo&task=task-1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total_rows, 1);
    // one row-joined rollout + one trace-only branch
    assert.equal(body.rollouts.length, 2);
    const joined = body.rollouts.find((r) => r.id === "row-0");
    assert.equal(joined.score, 1);
    assert.equal(joined.system, "You are an agent.");
    assert.ok(joined.turns.every((t) => t.role !== "system"));
    assert.equal(joined.snippet, "Rename UserStore.");
    assert.deepEqual(joined.subscores, { partial_credit: 1 });
    const traceOnly = body.rollouts.find((r) => r.id.startsWith("branch-"));
    assert.equal(traceOnly.status, "unscored");
    assert.equal(traceOnly.score, 0);
  });
  it("404s on unknown benchmarks and tasks", async () => {
    assert.equal((await rolloutsGET(new Request("http://x/api/rollouts?slug=data--nope&task=t"))).status, 404);
    assert.equal((await rolloutsGET(new Request("http://x/api/rollouts?slug=data--promoted-demo&task=nope"))).status, 404);
  });
  it("400s without params", async () => {
    assert.equal((await rolloutsGET(new Request("http://x/api/rollouts"))).status, 400);
  });
});
