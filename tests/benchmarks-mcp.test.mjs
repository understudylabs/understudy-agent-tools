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
    // Born accepted: an UNREVIEWED task queues under the default policy…
    fs.rmSync(path.join(proposedDir, "reviews.jsonl"));
    const born = callBenchmarksTool("queue_run", { slug: proposedSlug, models: ["m1"], tasks: [proposedTaskId] });
    assert.ok(born.run_id.startsWith("run-"));
    // …but review-policy default_decision "pending" restores the explicit-accept gate.
    fs.writeFileSync(
      path.join(proposedDir, "review-policy.json"),
      JSON.stringify({ schema_version: "understudy.review_policy.v1", default_decision: "pending" }),
    );
    assert.throws(
      () => callBenchmarksTool("queue_run", { slug: proposedSlug, models: ["m1"], tasks: [proposedTaskId] }),
      /not accepted yet \(unreviewed, review-policy default_decision "pending"\)/,
    );
    fs.rmSync(path.join(proposedDir, "review-policy.json"));
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

/* ---------------- regrade_run ---------------- */

describe("regrade_run", () => {
  it("refuses non-promoted stages", () => {
    assert.throws(() => callBenchmarksTool("regrade_run", { slug: proposedSlug }), /promoted benchmark dir/);
  });

  it("dry-runs by default and skips every row of a non-replayable verifier with an explicit reason", () => {
    const before = fs.readdirSync(promotedDir).filter((f) => f.startsWith("rows-"));
    const out = callBenchmarksTool("regrade_run", { slug: promotedSlug, run_id: "runa" });
    assert.equal(out.ok, true);
    assert.equal(out.dry_run, true); // default: plan only, zero writes
    assert.equal(out.summaries.length, 1);
    assert.equal(out.summaries[0].run_id, "runa");
    assert.equal(out.summaries[0].regraded.length, 0);
    assert.ok(out.summaries[0].skipped.length > 0);
    assert.ok(out.summaries[0].skipped.every((s) => s.reason === "verifier_not_replayable"));
    assert.deepEqual(fs.readdirSync(promotedDir).filter((f) => f.startsWith("rows-")), before);
  });
});

/* ---------------- apply_auto_accepts + submit_feedback ---------------- */

// A hand-written foundry dir with deterministic confidences for the policy tools.
function writeFoundryFixture(dir, tasks) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schema_version: "understudy.trace_foundry.v1",
      freshness: { max_age_days: 30, cutoff_utc: "2026-07-01T00:00:00Z", newest_capture_utc: "2026-07-20T00:00:00Z" },
      counts: { source_files: 1, captures: 1, tasks: tasks.length, edges: 0, stale_filtered: 0, invalid_timestamp_filtered: 0 },
    }),
  );
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({ schema_version: "understudy.benchmark_proposal.v1", benchmark_id: "mcp-policy-bench", tasks: tasks.map((t) => ({ task_id: t.task_id })) }),
  );
}

function foundryTask(id, overrides = {}) {
  return {
    schema_version: "understudy.benchmark_task.v1",
    task_id: id,
    execution_group: "g1",
    title: `task ${id}`,
    status: "machine_proposed",
    split: "construction",
    candidate_boundary: "b",
    machine_confidence: "high",
    close_call: false,
    tool_surface: [],
    outcome_contract: { required: [], preserved: [], forbidden: [], grading: "final_state" },
    world_model: {},
    source: { node_ids: [], edges: [], captures: [] },
    claims: [],
    sentinels: [],
    review: { decision: "pending" },
    ...overrides,
  };
}

const policyDir = path.join(tmp, "prop-policy");
const policySlug = "data--prop-policy";
writeFoundryFixture(policyDir, [foundryTask("t-clean"), foundryTask("t-shaky", { machine_confidence: "medium" })]);

describe("apply_auto_accepts", () => {
  it("applies the shared policy on explicit invocation only, stamping source:'auto'", () => {
    // Reading the benchmark never writes anything.
    callBenchmarksTool("read_benchmark", { slug: policySlug });
    assert.equal(fs.existsSync(path.join(policyDir, "reviews.jsonl")), false);

    const out = callBenchmarksTool("apply_auto_accepts", { slug: policySlug });
    assert.equal(out.ok, true);
    assert.deepEqual(out.applied, ["t-clean"]);
    assert.equal(out.applied_count, 1);
    assert.equal(out.exceptions, 1);
    const lines = fs.readFileSync(path.join(policyDir, "reviews.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].task_id, "t-clean");
    assert.equal(lines[0].decision, "accept");
    assert.equal(lines[0].source, "auto");

    // Idempotent: already-decided tasks are never re-decided.
    const again = callBenchmarksTool("apply_auto_accepts", { slug: policySlug });
    assert.deepEqual(again.applied, []);
  });

  it("honors a review-policy.json sidecar (min_confidence medium) and surfaces it in read_benchmark", () => {
    fs.writeFileSync(
      path.join(policyDir, "review-policy.json"),
      JSON.stringify({ schema_version: "understudy.review_policy.v1", min_confidence: "medium" }),
    );
    const bench = callBenchmarksTool("read_benchmark", { slug: policySlug });
    assert.equal(bench.review_policy.min_confidence, "medium");
    assert.equal(bench.review_policy.require_incumbent_pass, true);

    const out = callBenchmarksTool("apply_auto_accepts", { slug: policySlug });
    assert.deepEqual(out.applied, ["t-shaky"], "the medium-confidence task now clears the configured bar");
  });

  it("rejects promoted entries and unknown slugs", () => {
    assert.throws(() => callBenchmarksTool("apply_auto_accepts", { slug: promotedSlug }), /auto-accept only applies to proposed/);
    assert.throws(() => callBenchmarksTool("apply_auto_accepts", { slug: "data--nope" }), /unknown benchmark/);
  });
});

describe("submit_feedback", () => {
  it("appends an understudy.task_feedback.v1 line and returns the agent handoff", () => {
    const out = callBenchmarksTool("submit_feedback", { slug: policySlug, task_id: "t-clean", feedback: "gold contract over-specified" });
    assert.equal(out.ok, true);
    assert.equal(out.feedback.schema_version, "understudy.task_feedback.v1");
    assert.equal(out.feedback.task_id, "t-clean");
    assert.equal(out.feedback.status, "open");
    assert.ok(out.handoff.includes(`understudy traces regenerate-env --benchmark ${policyDir}`));
    assert.ok(out.handoff.includes("gold contract over-specified"));
    const lines = fs.readFileSync(path.join(policyDir, "feedback.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("validates through the shared write path (unknown task, empty feedback, promoted stage)", () => {
    assert.throws(() => callBenchmarksTool("submit_feedback", { slug: policySlug, task_id: "nope", feedback: "x" }), /unknown task_id/);
    assert.throws(() => callBenchmarksTool("submit_feedback", { slug: policySlug, task_id: "t-clean", feedback: "  " }), /non-empty string/);
    assert.throws(() => callBenchmarksTool("submit_feedback", { slug: promotedSlug, task_id: "t1", feedback: "x" }), /only applies to proposed/);
  });
});

/* ---------------- trivial-arm floors in read outputs ---------------- */

describe("floors in read_benchmark / run_status (additive)", () => {
  const calibration = {
    schema_version: "understudy.calibration.v1",
    benchmark_id: "promoted-bench",
    run_id: "run-cal",
    incumbent_models: ["modelA"],
    threshold: 1,
    started_at: null,
    finished_at: null,
    tasks: [
      { task_id: "t1", score: 1, passed: true, rollouts: 1 },
      { task_id: "t2", score: 0, passed: false, rollouts: 1 },
    ],
    passed_count: 1,
    failed_count: 1,
    failed_task_ids: ["t2"],
    null_floor: { arm_kind: "null_agent", floor: 0, passed_task_ids: [], floor_exceeded: false },
    spam_floor: { arm_kind: "spam_agent", floor: 0.5, passed_task_ids: ["t1"], floor_exceeded: true },
  };

  it("read_benchmark surfaces the calibration block with null/spam floors", () => {
    fs.writeFileSync(path.join(promotedDir, "calibration.json"), JSON.stringify(calibration));
    const out = callBenchmarksTool("read_benchmark", { slug: promotedSlug });
    assert.equal(out.calibration_present, true);
    assert.deepEqual(out.calibration.failed_task_ids, ["t2"]);
    assert.equal(out.calibration.null_floor.floor, 0);
    assert.equal(out.calibration.null_floor.floor_exceeded, false);
    assert.equal(out.calibration.spam_floor.floor_exceeded, true);
    assert.deepEqual(out.calibration.spam_floor.passed_task_ids, ["t1"]);
  });

  it("run_status carries the same floors block", () => {
    const queued = callBenchmarksTool("queue_run", { slug: promotedSlug, models: ["modelE"], tasks: "all", split: "all" });
    const status = callBenchmarksTool("run_status", { slug: promotedSlug, run_id: queued.run_id });
    assert.equal(status.calibration.run_id, "run-cal");
    assert.equal(status.calibration.spam_floor.floor, 0.5);
    assert.equal(status.calibration.spam_floor.floor_exceeded, true);
    assert.equal(status.calibration.null_floor.floor_exceeded, false);
    fs.rmSync(path.join(promotedDir, "calibration.json"));
  });

  it("stays additive: without a sidecar the calibration block is null", () => {
    const out = callBenchmarksTool("read_benchmark", { slug: promotedSlug });
    assert.equal(out.calibration_present, false);
    assert.equal(out.calibration, null);
  });
});

/* ---------------- roots + stdio protocol ---------------- */

/* ---------------- workload intake: profile_workload + from_dataset ---------------- */

describe("profile_workload", () => {
  const dropDir = path.join(tmp, "drop-src");
  fs.mkdirSync(path.join(dropDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dropDir, "README.md"), "# demo\n");
  fs.writeFileSync(
    path.join(dropDir, "data", "labeled.csv"),
    "text,label\nhello there,ham\nWIN A PRIZE,spam\nsee you at 5,ham\nFREE CASH NOW,spam\n",
  );
  const outputRoot = path.join(tmp, "capture-imports");

  it("profiles a directory and lists foundry-consumable dataset candidates", () => {
    const out = callBenchmarksTool("profile_workload", { path: dropDir, output_root: outputRoot });
    assert.equal(out.source_type, "directory");
    assert.equal(out.local_only, true);
    assert.deepEqual(out.dataset_candidates, [path.join(dropDir, "data", "labeled.csv")]);
    assert.equal(out.dataset_candidates_truncated, false);
    assert.ok(fs.existsSync(path.join(out.artifact_root, "workload-card.json")));
    assert.match(out.next, /from_dataset/);
  });

  it("profiles a single dataset file as its own candidate", () => {
    const out = callBenchmarksTool("profile_workload", {
      path: path.join(dropDir, "data", "labeled.csv"),
      output_root: outputRoot,
    });
    assert.equal(out.source_type, "file");
    assert.deepEqual(out.dataset_candidates, [path.join(dropDir, "data", "labeled.csv")]);
  });

  it("rejects a missing path", () => {
    assert.throws(() => callBenchmarksTool("profile_workload", { path: path.join(tmp, "nope") }), /does not exist/);
    assert.throws(() => callBenchmarksTool("profile_workload", {}), /path \(string\) is required/);
  });
});

describe("from_dataset", () => {
  const dataFile = path.join(tmp, "spam.csv");
  const rows = [["text", "label"]];
  for (let i = 0; i < 12; i += 1) rows.push([`ham message number ${i}`, "ham"], [`spam offer number ${i}`, "spam"]);
  fs.writeFileSync(dataFile, rows.map((r) => r.join(",")).join("\n") + "\n");

  it("compiles a labeled dataset into a proposed benchmark under the hub root", () => {
    const out = callBenchmarksTool("from_dataset", { source: dataFile, slug: "spam-intake", label_column: "label" });
    assert.equal(out.ok, true);
    assert.equal(out.slug, "data--spam-intake");
    assert.equal(out.dir, path.join(tmp, "spam-intake"));
    const manifest = JSON.parse(fs.readFileSync(path.join(out.dir, "benchmark.json"), "utf8"));
    assert.equal(manifest.schema_version, "understudy.benchmark_proposal.v1");
    assert.equal(manifest.status, "machine_compiled_review_pending");
    assert.equal(manifest.executable, false);
    assert.ok(manifest.promotion_blockers.includes("human_final_judgment"));
    // The proposed benchmark is immediately visible to the operator surface.
    const listed = callBenchmarksTool("list_benchmarks");
    assert.ok(listed.benchmarks.some((b) => b.slug === "data--spam-intake" && b.stage === "proposed"));
    // Born-versioned via the MCP path too: every generated task is stamped
    // 1.0.0 with env/verifier/meta content hashes (same stamping helper the
    // trace foundry uses), on both the sidecar and the manifest tasks.
    const sidecarTasks = fs
      .readFileSync(path.join(out.dir, "tasks.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(sidecarTasks.length > 0);
    for (const task of sidecarTasks) {
      assert.equal(task.version, "1.0.0");
      assert.match(task.content_hashes.env_sha256, /^[0-9a-f]{64}$/);
      assert.match(task.content_hashes.verifier_sha256, /^[0-9a-f]{64}$/);
      assert.match(task.content_hashes.meta_sha256, /^[0-9a-f]{64}$/);
    }
    for (const task of manifest.tasks) {
      assert.equal(task.version, "1.0.0");
      assert.match(task.content_hashes.env_sha256, /^[0-9a-f]{64}$/);
    }
  });

  it("refuses an existing dir, a bad slug, and a missing source", () => {
    assert.throws(() => callBenchmarksTool("from_dataset", { source: dataFile, slug: "spam-intake" }), /already exists/);
    assert.throws(() => callBenchmarksTool("from_dataset", { source: dataFile, slug: "Bad Slug!" }), /slug must be/);
    assert.throws(() => callBenchmarksTool("from_dataset", { source: path.join(tmp, "nope.csv"), slug: "x" }), /does not exist/);
  });
});

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
      [
        "apply_auto_accepts",
        "compare_prime_models",
        "create_experiment",
        "diff_rollouts",
        "freeze_prime_benchmark",
        "from_dataset",
        "list_benchmarks",
        "list_experiments",
        "plan_prime_run",
        "plan_provider_prime_run",
        "prime_status",
        "profile_workload",
        "provider_prime_status",
        "queue_run",
        "read_benchmark",
        "read_rollout",
        "read_task",
        "regrade_run",
        "review_prime_benchmark",
        "run_status",
        "submit_feedback",
        "submit_review",
        "update_experiment",
      ],
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
