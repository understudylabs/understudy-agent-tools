import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  NULL_AGENT_FINAL_RESPONSE,
  TRIVIAL_FLOOR_LIMIT,
  createRunRequest,
  deriveCalibrationSummary,
  executeRunRequest,
  mergeCalibrationFloors,
  nullAgentRunner,
  readRunRequest,
  runRequestPath,
  schemaMinimalArguments,
  spamAgentRunner,
  spamToolSurface,
  validateRunRequestInput,
} from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A benchmark with two tasks:
 * - t1 is satisfiable by RITUAL: its required state effect has no anchor
 *   arguments, so any call to update-record satisfies it (the spam class).
 * - t2 anchors on a real id ("record-12345"), so schema-minimal arguments
 *   never satisfy it.
 */
function makeBenchmarkDir({ withSchemas = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivial-arms-"));
  roots.push(dir);
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "trivial-bench",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [
        { task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "train" },
        { task_id: "t2", category_id: "cat-a", genesis: "replayed", split: "holdout" },
      ],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit" },
    }),
  );
  const sidecar = [
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      title: "Trivially satisfiable",
      outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: {} }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    },
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t2",
      title: "Anchored",
      outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "record-12345" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    },
  ];
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), sidecar.map((t) => JSON.stringify(t)).join("\n") + "\n");
  if (withSchemas) {
    const servers = path.join(dir, "environment", "understudy_trace_env", "servers");
    fs.mkdirSync(servers, { recursive: true });
    fs.writeFileSync(
      path.join(servers, "schemas.json"),
      JSON.stringify({
        "update-record": { required: ["id"], properties: { id: "string", active: "boolean" } },
        "create-item": { required: ["name", "count"], properties: { name: "string", count: "integer" }, enums_by_observation: { kind: ["widget", "gadget"] } },
        "list-items": { required: [], properties: {} },
      }),
    );
  }
  return dir;
}

const queueRun = (dir, overrides = {}) =>
  createRunRequest(dir, {
    benchmark_id: "trivial-bench",
    models: ["candidate-model"],
    split: "all",
    tasks: "all",
    rollouts_per_task: 1,
    ...overrides,
  });

const readRows = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^rows-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

const sidecarTask = (dir, taskId) =>
  fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((t) => t.task_id === taskId);

describe("run-request trivial_arms validation (additive)", () => {
  const known = ["t1", "t2"];
  const base = { models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1 };
  it("accepts valid trivial_arms and stays valid when omitted", () => {
    assert.deepEqual(validateRunRequestInput(base, known), []);
    assert.deepEqual(validateRunRequestInput({ ...base, trivial_arms: ["null_agent"] }, known), []);
    assert.deepEqual(validateRunRequestInput({ ...base, trivial_arms: ["null_agent", "spam_agent"] }, known), []);
  });
  it("rejects unknown kinds, duplicates, and non-arrays", () => {
    assert.ok(validateRunRequestInput({ ...base, trivial_arms: ["chaos_agent"] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, trivial_arms: ["null_agent", "null_agent"] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, trivial_arms: "null_agent" }, known).length > 0);
  });
  it("omits the field from the persisted request when unused (old readers see the prior shape)", () => {
    const dir = makeBenchmarkDir();
    const plain = queueRun(dir);
    assert.ok(!("trivial_arms" in readRunRequest(runRequestPath(dir, plain.run_id))));
    const withArms = queueRun(dir, { trivial_arms: ["null_agent"] });
    assert.deepEqual(readRunRequest(runRequestPath(dir, withArms.run_id)).trivial_arms, ["null_agent"]);
  });
});

describe("nullAgentRunner", () => {
  it("makes zero tool calls, answers boilerplate, and is deterministic", async () => {
    const dir = makeBenchmarkDir();
    const runner = nullAgentRunner();
    const args = { benchmarkDir: dir, model: "null_agent", task: sidecarTask(dir, "t1"), rollout: 0, selectedTaskIds: ["t1", "t2"], journalPath: null };
    const a = await runner(args);
    const b = await runner(args);
    for (const result of [a, b]) {
      assert.equal(result.status, "ok");
      assert.equal(result.score, 0, "a do-nothing agent must not pass a state-effect contract");
      assert.equal(result.cost, 0);
      assert.equal(result.tool_call_count, 0);
      assert.deepEqual(result.writes, []);
      assert.equal(result.final_response_chars, NULL_AGENT_FINAL_RESPONSE.length);
      assert.equal(result.subscores.runner_null_agent, 1);
    }
    // Deterministic in everything but wall-clock latency.
    assert.deepEqual({ ...a, latency_ms: 0 }, { ...b, latency_ms: 0 });
  });
});

describe("spamAgentRunner", () => {
  it("derives schema-minimal arguments deterministically", () => {
    const schema = { required: ["name", "count"], properties: { name: "string", count: "integer" }, enums_by_observation: { kind: ["widget", "gadget"] } };
    assert.deepEqual(schemaMinimalArguments(schema), { name: "", count: 0, kind: "widget" });
    assert.deepEqual(schemaMinimalArguments(schema), schemaMinimalArguments(schema));
    assert.deepEqual(schemaMinimalArguments({ required: ["flag", "meta", "rows"], properties: { flag: "boolean", meta: "object", rows: "array" } }), { flag: false, meta: {}, rows: [] });
  });

  it("tool surface comes from schemas.json (sorted), falling back to the contract's tools", () => {
    const dir = makeBenchmarkDir();
    assert.deepEqual(spamToolSurface(dir, sidecarTask(dir, "t1")).map((c) => c.tool), ["create-item", "list-items", "update-record"]);
    const bare = makeBenchmarkDir({ withSchemas: false });
    assert.deepEqual(spamToolSurface(bare, sidecarTask(bare, "t2")), [{ tool: "update-record", arguments: {} }]);
  });

  it("calls every tool once, passes ritual-satisfiable contracts, fails anchored ones, deterministically", async () => {
    const dir = makeBenchmarkDir();
    const runner = spamAgentRunner();
    const run = (taskId) => runner({ benchmarkDir: dir, model: "spam_agent", task: sidecarTask(dir, taskId), rollout: 0, selectedTaskIds: ["t1", "t2"], journalPath: null });
    const t1a = await run("t1");
    const t1b = await run("t1");
    assert.equal(t1a.status, "ok");
    assert.equal(t1a.score, 1, "an anchor-free contract is satisfiable by ritual tool calling — exactly what the floor must catch");
    assert.equal(t1a.tool_call_count, 3);
    assert.equal(t1a.cost, 0);
    assert.deepEqual(t1a.writes.map((w) => w.tool), ["create-item", "update-record"]);
    assert.deepEqual({ ...t1a, latency_ms: 0 }, { ...t1b, latency_ms: 0 });
    const t2 = await run("t2");
    assert.equal(t2.score, 0, "anchored arguments defeat schema-minimal spam");
  });
});

describe("executor with trivial arms", () => {
  it("runs trivial arms alongside model arms: labeled rows, one rollout per task, no anomaly sentinels, floors in calibration.json", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["candidate-model"], rollouts_per_task: 2, trivial_arms: ["null_agent", "spam_agent"] });
    // The candidate completes ok with a real call so its rows stay clean.
    const runner = async ({ journalPath }) => {
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ kind: "call", tool: "update-record", status: "ok" }) + "\n");
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: { id: "record-12345" } }], tool_call_count: 1 };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    // 1 model × 2 tasks × 2 rollouts + 2 trivial arms × 2 tasks × 1 rollout.
    assert.deepEqual(result.progress, { completed: 8, total: 8 });

    const rows = readRows(dir);
    const nullRows = rows.filter((r) => r.arm_kind === "null_agent");
    const spamRows = rows.filter((r) => r.arm_kind === "spam_agent");
    assert.equal(rows.filter((r) => r.arm_kind === "candidate").length, 4);
    assert.equal(nullRows.length, 2, "trivial arms run exactly one rollout per task");
    assert.equal(spamRows.length, 2);
    assert.ok(nullRows.every((r) => r.model === "null_agent" && r.cost === 0));

    // Sentinels must NOT misfire on trivial arms: zero calls + zero score is
    // the null agent working as designed, never an anomaly.
    const nullT2 = nullRows.find((r) => r.task_id === "t2");
    assert.equal(nullT2.score, 0);
    assert.equal(nullT2.tool_call_count, 0);
    assert.ok(!("anomaly" in nullT2) && !("anomalies" in nullT2), "trivial-arm rows are never anomaly-flagged");
    assert.ok(spamRows.every((r) => !("anomaly" in r)));

    const calibration = JSON.parse(fs.readFileSync(path.join(dir, "calibration.json"), "utf8"));
    assert.equal(calibration.null_floor.floor, 0);
    assert.equal(calibration.null_floor.floor_exceeded, false);
    assert.deepEqual(calibration.null_floor.passed_task_ids, []);
    assert.equal(calibration.spam_floor.floor, 0.5, "spam passes the ritual-satisfiable t1");
    assert.equal(calibration.spam_floor.floor_exceeded, true);
    assert.deepEqual(calibration.spam_floor.passed_task_ids, ["t1"]);
    // Trivial-only floors make no incumbent claim.
    assert.deepEqual(calibration.tasks, []);
    assert.deepEqual(calibration.failed_task_ids, []);
  });

  it("carries trivial floors forward across an incumbent-only rerun, and a new trivial run recomputes them", async () => {
    const dir = makeBenchmarkDir();
    const okRunner = async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: { id: "record-12345" } }], tool_call_count: 1 });
    const calibration = () => JSON.parse(fs.readFileSync(path.join(dir, "calibration.json"), "utf8"));

    // 1. calibproof run: trivial arms compute the floors.
    const first = queueRun(dir, { trivial_arms: ["null_agent", "spam_agent"] });
    await executeRunRequest(dir, first.run_id, { runner: okRunner });
    const before = calibration();
    assert.equal(before.spam_floor.floor, 0.5);
    assert.ok(!("source_run_id" in before.spam_floor), "a floor this run computed carries no carry-forward provenance");

    // 2. incumbent-only rerun (no trivial arms): floors must SURVIVE, with
    //    honest provenance pointing at the run that computed them.
    const second = queueRun(dir, { incumbent_models: ["candidate-model"] });
    await executeRunRequest(dir, second.run_id, { runner: okRunner });
    const after = calibration();
    assert.equal(after.run_id, second.run_id);
    assert.ok(after.tasks.length > 0, "the incumbent rerun's own claim is intact");
    assert.equal(after.null_floor.floor, before.null_floor.floor);
    assert.equal(after.spam_floor.floor, before.spam_floor.floor);
    assert.deepEqual(after.spam_floor.passed_task_ids, ["t1"]);
    assert.equal(after.null_floor.source_run_id, first.run_id);
    assert.equal(after.spam_floor.source_run_id, first.run_id);
    assert.equal(after.spam_floor.source_ts, before.finished_at);

    // 3. a NEW trivial run recomputes its own arm (no stale provenance) and
    //    still carries the arm it did not rerun — preserving the ORIGINAL
    //    computing run across a double carry.
    const third = queueRun(dir, { trivial_arms: ["null_agent"] });
    await executeRunRequest(dir, third.run_id, { runner: okRunner });
    const final = calibration();
    assert.equal(final.run_id, third.run_id);
    assert.ok(!("source_run_id" in final.null_floor), "recomputed floors win and drop carry provenance");
    assert.equal(final.spam_floor.source_run_id, first.run_id, "double-carried floors keep the original computing run");
  });

  it("mergeCalibrationFloors: recomputed floors win; missing floors carry with provenance; no prior file is a no-op", () => {
    const floor = (extra = {}) => ({ arm_kind: "null_agent", floor: 0, passed_task_ids: [], floor_exceeded: false, ...extra });
    const next = { schema_version: "understudy.benchmark_calibration.v1", run_id: "run-new", finished_at: "2026-07-22T01:00:00Z", started_at: null, null_floor: floor({ floor: 0.25 }) };
    assert.deepEqual(mergeCalibrationFloors(null, next), next);
    const prior = { run_id: "run-old", finished_at: "2026-07-20T00:00:00Z", started_at: null, null_floor: floor(), spam_floor: floor({ arm_kind: "spam_agent", floor: 0.5 }) };
    const merged = mergeCalibrationFloors(prior, next);
    assert.equal(merged.null_floor.floor, 0.25, "this run recomputed null_floor — it wins");
    assert.ok(!("source_run_id" in merged.null_floor));
    assert.deepEqual(merged.spam_floor, { ...prior.spam_floor, source_run_id: "run-old", source_ts: "2026-07-20T00:00:00Z" });
  });

  it("still flags anomalies on candidate rows in the same run (candidate-arm-only sentinels, not sentinels-off)", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["lazy-model"], trivial_arms: ["null_agent"] });
    // The candidate silently does nothing — the classic silent zero.
    const runner = async () => ({ score: 0, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [], tool_call_count: 0 });
    await executeRunRequest(dir, run.run_id, { runner });
    const rows = readRows(dir);
    assert.ok(rows.filter((r) => r.arm_kind === "candidate").every((r) => r.anomaly), "candidate silent zeros stay flagged");
    assert.ok(rows.filter((r) => r.arm_kind === "null_agent").every((r) => !r.anomaly), "trivial rows never flagged");
  });

  it("deriveCalibrationSummary keeps incumbent semantics and adds floors additively", () => {
    const summary = deriveCalibrationSummary({
      benchmarkId: "b",
      runId: "run-x",
      incumbentModels: ["inc"],
      selectedTaskIds: ["t1", "t2"],
      trivialArms: ["null_agent"],
      rows: [
        { run_id: "run-x", model: "inc", arm_kind: "incumbent", task_id: "t1", status: "ok", score: 1 },
        { run_id: "run-x", model: "inc", arm_kind: "incumbent", task_id: "t2", status: "ok", score: 1 },
        { run_id: "run-x", model: "null_agent", arm_kind: "null_agent", task_id: "t1", status: "ok", score: 1 },
        { run_id: "run-x", model: "null_agent", arm_kind: "null_agent", task_id: "t2", status: "ok", score: 0 },
      ],
      events: [],
    });
    assert.equal(summary.passed_count, 2);
    assert.equal(summary.null_floor.floor, 0.5);
    assert.equal(summary.null_floor.floor_exceeded, true);
    assert.deepEqual(summary.null_floor.passed_task_ids, ["t1"]);
    assert.ok(!("spam_floor" in summary), "arms not run stay absent (additive)");
    assert.ok(TRIVIAL_FLOOR_LIMIT > 0 && TRIVIAL_FLOOR_LIMIT < 1);
  });

  it("no trivial arms requested → no trivial rows, no floors (prior behavior intact)", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], incumbent_models: ["m1"] });
    const runner = async ({ journalPath }) => {
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ kind: "call", tool: "update-record", status: "ok" }) + "\n");
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: {} }], tool_call_count: 1 };
    };
    await executeRunRequest(dir, run.run_id, { runner });
    assert.ok(readRows(dir).every((r) => r.arm_kind === "incumbent"));
    const calibration = JSON.parse(fs.readFileSync(path.join(dir, "calibration.json"), "utf8"));
    assert.ok(!("null_floor" in calibration) && !("spam_floor" in calibration));
  });
});
