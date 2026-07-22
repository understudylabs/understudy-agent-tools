import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The MCP tools are exercised directly through the compiled dist (same
// pattern the hub's route tests use), plus one stdio protocol smoke.
import { BENCHMARKS_TOOLS, callBenchmarksTool, configureBenchmarksMcpRoots } from "../dist/benchmarks-mcp.js";
import { compileTraceFoundry } from "../dist/trace-foundry.js";

const bin = path.resolve("dist/bin.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmarks-mcp-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const reviewSchema = JSON.parse(
  fs.readFileSync(path.resolve("schemas/understudy.benchmark_review.v1.schema.json"), "utf8"),
);

/* ---------------- fixtures ---------------- */

// A promoted benchmark with a task sidecar, rows, and two live journals.
const promotedDir = path.join(tmp, "promoted");
fs.mkdirSync(path.join(promotedDir, "runs", "live"), { recursive: true });
fs.writeFileSync(
  path.join(promotedDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "promoted-bench",
    name: "Promoted bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [
      { task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" },
      { task_id: "t2", category_id: "cat-a", genesis: "synthesized", split: "dev" },
    ],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);
fs.writeFileSync(
  path.join(promotedDir, "tasks.jsonl"),
  JSON.stringify({
    task_id: "t1",
    title: "Set record 7 active",
    outcome_contract: {
      required: [{ type: "state_effect", tool: "update-record", observed_arguments: { record_id: 7 } }],
      preserved: [],
      forbidden: [],
      grading: "final_state_and_obligations",
    },
    world_model: { status: "machine_proposed", transitions: [{ tool: "update-record" }] },
  }) + "\n",
);
const row = (runId, model, taskId, score) =>
  JSON.stringify({
    schema_version: "understudy.eval_result.v1",
    run_id: runId,
    task_id: taskId,
    split: "holdout",
    score,
    status: "ok",
    model,
    benchmark_id: "promoted-bench",
  }) + "\n";
fs.writeFileSync(path.join(promotedDir, "rows-runa-modelA.jsonl"), row("runa", "modelA", "t1", 1) + row("runa", "modelA", "t2", 0.5));
fs.writeFileSync(path.join(promotedDir, "rows-runb-modelB.jsonl"), row("runb", "modelB", "t1", 0));
// runa (passing): calls update-record with the anchored record_id.
fs.writeFileSync(
  path.join(promotedDir, "runs", "live", "runa-modelA.jsonl"),
  [
    JSON.stringify({ at: 1, kind: "call", tool: "list-records", write: false, status: "ok", arguments: "{}" }),
    JSON.stringify({ at: 2, kind: "result", tool: "list-records", status: "ok", content: "[7]" }),
    JSON.stringify({ at: 3, kind: "call", tool: "update-record", write: true, status: "ok", arguments: JSON.stringify({ record_id: 7, active: true }) }),
    JSON.stringify({ at: 4, kind: "result", tool: "update-record", status: "ok", content: '{"ok": true}' }),
  ].join("\n") + "\n",
);
// runb (failing): never performs the required write; diverges at call index 1.
fs.writeFileSync(
  path.join(promotedDir, "runs", "live", "runb-modelB.jsonl"),
  [
    JSON.stringify({ at: 1, kind: "call", tool: "list-records", write: false, status: "ok", arguments: "{}" }),
    JSON.stringify({ at: 2, kind: "call", tool: "get-record", write: false, status: "ok", arguments: JSON.stringify({ record_id: 7 }) }),
  ].join("\n") + "\n",
);

// A real proposed (trace-foundry) benchmark compiled from one capture.
const source = path.join(tmp, "_captures-src");
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(
  path.join(source, "one.json"),
  JSON.stringify({
    schema_version: 4,
    request_id: "round-1",
    ts: "2026-07-20T12:00:00Z",
    customer_request_body: JSON.stringify({
      system: "sys",
      messages: [{ role: "user", content: "Set record 7 active" }],
      tools: [],
    }),
    response_body: JSON.stringify({ content: [{ type: "tool_use", id: "c1", name: "update-record", input: { record_id: 7 } }] }),
    status_code: 200,
  }),
);
const proposedDir = path.join(tmp, "proposed-demo");
compileTraceFoundry(source, proposedDir, 36500, new Date("2026-07-21T12:00:00Z"));
// _captures-src must not scan as a benchmark dir (it has no manifest) — fine.
const proposedTaskId = JSON.parse(fs.readFileSync(path.join(proposedDir, "tasks.jsonl"), "utf8").trim().split("\n")[0]).task_id;

const promotedSlug = "data--promoted";
const proposedSlug = "data--proposed-demo";

/* ---------------- read tools ---------------- */

describe("list_benchmarks / read_benchmark / read_task", () => {
  it("lists both stages with task counts and review summaries", () => {
    const out = callBenchmarksTool("list_benchmarks", {});
    const bySlug = new Map(out.benchmarks.map((b) => [b.slug, b]));
    const promoted = bySlug.get(promotedSlug);
    assert.equal(promoted.stage, "promoted");
    assert.equal(promoted.tasks, 2);
    assert.equal(promoted.rows, 3);
    const proposed = bySlug.get(proposedSlug);
    assert.equal(proposed.stage, "proposed");
    assert.ok(proposed.tasks >= 1);
    assert.equal(proposed.reviews.unreviewed, proposed.tasks);
  });

  it("read_benchmark returns manifest + per-task score summaries", () => {
    const out = callBenchmarksTool("read_benchmark", { slug: promotedSlug });
    assert.equal(out.manifest.benchmark_id, "promoted-bench");
    const t1 = out.tasks.find((t) => t.task_id === "t1");
    assert.equal(t1.scores.rows, 2);
    assert.equal(t1.scores.by_model.modelA.mean_score, 1);
    assert.equal(t1.scores.by_model.modelB.mean_score, 0);
  });

  it("read_task surfaces the outcome contract and world model on both stages", () => {
    const promotedTask = callBenchmarksTool("read_task", { slug: promotedSlug, task_id: "t1" });
    assert.equal(promotedTask.outcome_contract.required[0].tool, "update-record");
    assert.equal(promotedTask.world_model_summary.transitions, 1);

    const proposedTask = callBenchmarksTool("read_task", { slug: proposedSlug, task_id: proposedTaskId });
    assert.ok(Array.isArray(proposedTask.outcome_contract.required));
    assert.ok(proposedTask.prompt.length > 0);
    assert.equal(proposedTask.review, null);
  });

  it("rejects unknown slugs and task ids", () => {
    assert.throws(() => callBenchmarksTool("read_benchmark", { slug: "data--nope" }), /unknown benchmark/);
    assert.throws(() => callBenchmarksTool("read_task", { slug: promotedSlug, task_id: "nope" }), /unknown task_id/);
  });
});

/* ---------------- rollouts + diff ---------------- */

describe("read_rollout / diff_rollouts", () => {
  it("returns the trajectory with per-obligation contract scoring (shared scorer)", () => {
    const out = callBenchmarksTool("read_rollout", { slug: promotedSlug, run_id: "runa", task_id: "t1", model: "modelA" });
    assert.equal(out.events.length, 4);
    assert.equal(out.events[2].tool, "update-record");
    assert.deepEqual(out.events[2].arguments, { record_id: 7, active: true });
    assert.equal(out.obligations.length, 1);
    assert.equal(out.obligations[0].met, true);
    assert.equal(out.verdict.task_completed_correctly, true);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].score, 1);
  });

  it("falls back to the newest journal for the run when model is omitted", () => {
    const out = callBenchmarksTool("read_rollout", { slug: promotedSlug, run_id: "runb", task_id: "t1" });
    assert.equal(out.model, "modelB");
    assert.equal(out.obligations[0].met, false);
    assert.equal(out.verdict.task_completed_correctly, false);
  });

  it("diffs obligations and finds the first tool-call divergence", () => {
    const out = callBenchmarksTool("diff_rollouts", { slug: promotedSlug, task_id: "t1", run_a: "runa", run_b: "runb" });
    assert.equal(out.tool_sequence.diverges_at, 1);
    assert.deepEqual(out.a.calls, ["list-records", "update-record"]);
    assert.deepEqual(out.b.calls, ["list-records", "get-record"]);
    const obligation = out.obligations[0];
    assert.equal(obligation.a.met, true);
    assert.equal(obligation.b.met, false);
    assert.equal(obligation.same, false);
  });

  it("errors clearly when no journal exists", () => {
    assert.throws(
      () => callBenchmarksTool("read_rollout", { slug: promotedSlug, run_id: "ghost", task_id: "t1" }),
      /no trajectory journal/,
    );
  });
});

/* ---------------- submit_review (append contract) ---------------- */

describe("submit_review", () => {
  it("rejects bad decisions, long notes, unknown tasks, and promoted entries", () => {
    assert.throws(
      () => callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: proposedTaskId, decision: "maybe" }),
      /decision must be one of accept, restrict, needs_more, reject/,
    );
    assert.throws(
      () => callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: proposedTaskId, decision: "accept", note: "x".repeat(2001) }),
      /note too long/,
    );
    assert.throws(
      () => callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: "nope", decision: "accept" }),
      /unknown task_id/,
    );
    assert.throws(
      () => callBenchmarksTool("submit_review", { slug: promotedSlug, task_id: "t1", decision: "accept" }),
      /reviews only apply to proposed/,
    );
  });

  it("appends schema-valid lines; the newest line per task wins", () => {
    const first = callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: proposedTaskId, decision: "needs_more", note: "check gold" });
    assert.equal(first.review.schema_version, "understudy.benchmark_review.v1");
    for (const key of reviewSchema.required) assert.ok(key in first.review, `review is missing ${key}`);
    assert.ok(reviewSchema.properties.decision.enum.includes(first.review.decision));

    callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: proposedTaskId, decision: "accept", note: "fixed" });
    const lines = fs.readFileSync(path.join(proposedDir, "reviews.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2); // append-only, no rewrites
    assert.equal(JSON.parse(lines[0]).decision, "needs_more");
    assert.equal(JSON.parse(lines[1]).decision, "accept");

    const bench = callBenchmarksTool("read_benchmark", { slug: proposedSlug });
    const task = bench.tasks.find((t) => t.task_id === proposedTaskId);
    assert.equal(task.review.decision, "accept"); // newest wins
  });
});

/* ---------------- queue_run + run_status ---------------- */

describe("queue_run / run_status", () => {
  it("validates against the shared run_request schema", () => {
    assert.throws(() => callBenchmarksTool("queue_run", { slug: promotedSlug, models: [] }), /models must be a non-empty array/);
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["m1"], tasks: ["ghost-task"] }),
      /unknown task_id: ghost-task/,
    );
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["m1"], split: "weekend" }),
      /split must be one of/,
    );
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["m1"], rollouts_per_task: 0 }),
      /rollouts_per_task/,
    );
  });

  it("gates proposed benchmarks: single accepted task with a ready environment only", () => {
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: proposedSlug, models: ["m1"] }),
      /single-task runs only/,
    );
    // An UNREVIEWED proposal rejects queueing outright.
    fs.rmSync(path.join(proposedDir, "reviews.jsonl"));
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: proposedSlug, models: ["m1"], tasks: [proposedTaskId] }),
      /not accepted yet \(unreviewed\)/,
    );
    // Re-accept: the accepted task + foundry-validated environment queues (still no execution).
    callBenchmarksTool("submit_review", { slug: proposedSlug, task_id: proposedTaskId, decision: "accept", note: "ok" });
    const out = callBenchmarksTool("queue_run", { slug: proposedSlug, models: ["m1"], tasks: [proposedTaskId] });
    const onDisk = JSON.parse(fs.readFileSync(path.join(proposedDir, "runs", "queue", `${out.run_id}.json`), "utf8"));
    assert.equal(onDisk.schema_version, "understudy.run_request.v1");
    assert.equal(onDisk.status, "queued");
    assert.equal(onDisk.split, "all"); // proposed single-task runs are pinned to split "all"
  });

  it("writes an understudy.run_request.v1 into runs/queue and never executes", () => {
    const out = callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["modelC"], tasks: ["t1"], split: "holdout" });
    assert.ok(out.run_id.startsWith("run-"));
    const file = path.join(promotedDir, "runs", "queue", `${out.run_id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.schema_version, "understudy.run_request.v1");
    assert.equal(onDisk.status, "queued");
    assert.deepEqual(onDisk.models, ["modelC"]);
    assert.deepEqual(onDisk.tasks, ["t1"]);
    assert.equal(onDisk.progress.completed, 0);
    // No rows appeared for this run — nothing executed.
    assert.equal(fs.readdirSync(promotedDir).some((f) => f.includes(out.run_id)), false);

    const status = callBenchmarksTool("run_status", { slug: promotedSlug, run_id: out.run_id });
    assert.equal(status.status, "queued");
    assert.equal(status.rows.rows, 0);
  });

  it("run_status summarizes rows per model and task as they land", () => {
    const queued = callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["modelD"], tasks: "all", split: "all" });
    fs.writeFileSync(
      path.join(promotedDir, `rows-${queued.run_id}-modelD.jsonl`),
      row(queued.run_id, "modelD", "t1", 1) + row(queued.run_id, "modelD", "t2", 0),
    );
    const status = callBenchmarksTool("run_status", { slug: promotedSlug, run_id: queued.run_id });
    assert.equal(status.rows.rows, 2);
    assert.equal(status.rows.by_model.modelD.mean_score, 0.5);
    assert.deepEqual(status.per_task.map((t) => t.task_id), ["t1", "t2"]);
    assert.throws(() => callBenchmarksTool("run_status", { slug: promotedSlug, run_id: "ghost" }), /unknown run_id/);
  });
});

/* ---------------- roots + stdio protocol ---------------- */

describe("server wiring", () => {
  it("configureBenchmarksMcpRoots appends extra roots after the defaults", () => {
    const saved = process.env.BENCHMARK_HUB_DATA_DIR;
    try {
      configureBenchmarksMcpRoots([]);
      assert.equal(process.env.BENCHMARK_HUB_DATA_DIR, saved); // no-op without roots
      configureBenchmarksMcpRoots(["/tmp/extra-bench"]);
      assert.equal(process.env.BENCHMARK_HUB_DATA_DIR, `${saved}:${path.resolve("/tmp/extra-bench")}`);
    } finally {
      process.env.BENCHMARK_HUB_DATA_DIR = saved;
    }
  });

  it("`understudy benchmarks mcp` serves the tools over stdio", async () => {
    const responses = await mcpSession([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list", params: {} },
      { id: 3, method: "tools/call", params: { name: "read_benchmark", arguments: { slug: promotedSlug } } },
    ]);
    const names = responses.get(2).result.tools.map((t) => t.name).sort();
    assert.deepEqual(
      names,
      ["diff_rollouts", "list_benchmarks", "queue_run", "read_benchmark", "read_rollout", "read_task", "run_status", "submit_review"],
    );
    assert.equal(responses.get(2).result.tools.length, BENCHMARKS_TOOLS.length);
    const body = JSON.parse(responses.get(3).result.content[0].text);
    assert.equal(body.manifest.benchmark_id, "promoted-bench");
  });
});

// minimal JSON-RPC-over-stdio MCP client against `understudy benchmarks mcp`
function mcpSession(requests, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [bin, "benchmarks", "mcp"], {
      env: { ...process.env, BENCHMARK_HUB_DATA_DIR: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const expected = requests.filter((r) => r.id !== undefined).length;
    const responses = new Map();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout; got ${responses.size}/${expected} responses`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // any non-JSON on stdout is a protocol violation → test fails
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.size === expected) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(responses);
        }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}
