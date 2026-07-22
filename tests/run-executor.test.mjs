import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  cancelRunRequest,
  createRunRequest,
  executeRunRequest,
  listRunRequests,
  oracleRunner,
  readRunRequest,
  runRequestPath,
  selectTasks,
  validateRunRequestInput,
} from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A minimal promoted benchmark dir with a foundry tasks.jsonl sidecar. */
function makeBenchmarkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-exec-"));
  roots.push(dir);
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "exec-bench",
      provenance: { origin: "derived-from-traces" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [
        { task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "holdout" },
        { task_id: "t2", category_id: "cat-a", genesis: "replayed", split: "train" },
      ],
      environment: { format: "verifiers.v1", package_ref: "environment" },
      verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit" },
    }),
  );
  const sidecar = [
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      outcome_contract: { required: [{ tool: "update-record", observed_arguments: { id: "r1" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    },
    {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t2",
      outcome_contract: { required: [{ tool: "create-item", observed_arguments: { name: "x" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
    },
  ];
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), sidecar.map((t) => JSON.stringify(t)).join("\n") + "\n");
  return dir;
}

const queueRun = (dir, overrides = {}) =>
  createRunRequest(dir, {
    benchmark_id: "exec-bench",
    models: ["model-a", "model-b"],
    split: "all",
    tasks: "all",
    rollouts_per_task: 1,
    ...overrides,
  });

const readEvents = (dir) =>
  fs.existsSync(path.join(dir, "runs", "events.jsonl"))
    ? fs.readFileSync(path.join(dir, "runs", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

const readRows = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^rows-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));

describe("validateRunRequestInput", () => {
  it("accepts a sane input and rejects each broken field", () => {
    const known = ["t1", "t2"];
    assert.deepEqual(validateRunRequestInput({ models: ["m"], split: "all", tasks: "all", rollouts_per_task: 1 }, known), []);
    assert.ok(validateRunRequestInput({ models: [], split: "all", tasks: "all", rollouts_per_task: 1 }, known).length > 0);
    assert.ok(validateRunRequestInput({ models: ["m", "m"], split: "all", tasks: "all", rollouts_per_task: 1 }, known).length > 0);
    assert.ok(validateRunRequestInput({ models: ["m"], split: "prod", tasks: "all", rollouts_per_task: 1 }, known).length > 0);
    assert.ok(validateRunRequestInput({ models: ["m"], split: "all", tasks: ["nope"], rollouts_per_task: 1 }, known).length > 0);
    assert.ok(validateRunRequestInput({ models: ["m"], split: "all", tasks: "all", rollouts_per_task: 0 }, known).length > 0);
  });
});

describe("selectTasks", () => {
  it("filters by split and explicit ids", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(makeBenchmarkDir(), "benchmark.json"), "utf8"));
    assert.equal(selectTasks(manifest, { split: "all", tasks: "all" }).length, 2);
    assert.deepEqual(selectTasks(manifest, { split: "holdout", tasks: "all" }).map((t) => t.task_id), ["t1"]);
    assert.deepEqual(selectTasks(manifest, { split: "all", tasks: ["t2"] }).map((t) => t.task_id), ["t2"]);
  });
});

describe("executeRunRequest state machine", () => {
  it("runs queued→running→done on a mocked runner, streaming events and rows", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { rollouts_per_task: 2 });
    const calls = [];
    const runner = async ({ model, task, rollout }) => {
      calls.push(`${model}:${task.task_id}:${rollout}`);
      return { score: 1, subscores: { final_state: 1 }, status: "ok", latency_ms: 5, cost: 0.001, writes: [{ tool: "update-record", arguments: { id: "r1" } }] };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    assert.deepEqual(result.progress, { completed: 8, total: 8 }); // 2 models × 2 tasks × 2 rollouts
    assert.equal(calls.length, 8);

    const events = readEvents(dir);
    assert.equal(events.filter((e) => e.type === "rollout").length, 8);
    assert.ok(events.some((e) => e.type === "run_started"));
    assert.ok(events.at(-1).type === "run_finished");

    const rows = readRows(dir);
    assert.equal(rows.length, 8);
    for (const row of rows) {
      assert.equal(row.schema_version, "understudy.eval_result.v1");
      assert.equal(row.benchmark_id, "exec-bench");
      assert.equal(row.run_id, run.run_id);
      assert.equal(row.category_id, "cat-a");
      assert.ok(Array.isArray(row.writes));
    }
    // Per-model rows files (the hub's rows-*.jsonl glob).
    const files = fs.readdirSync(dir).filter((f) => /^rows-.*\.jsonl$/.test(f));
    assert.equal(files.length, 2);
  });

  it("persists partial progress to the request file after every rollout", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], rollouts_per_task: 1 });
    const snapshots = [];
    const runner = async () => {
      snapshots.push(readRunRequest(runRequestPath(dir, run.run_id)).progress.completed);
      return { score: 0.5, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] };
    };
    await executeRunRequest(dir, run.run_id, { runner });
    // Before rollout N ran, N-1 completions were already persisted on disk.
    assert.deepEqual(snapshots, [0, 1]);
  });

  it("honors an external cancel flip between rollouts", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], rollouts_per_task: 3 }); // 6 rollouts
    let n = 0;
    const runner = async () => {
      n += 1;
      if (n === 2) cancelRunRequest(dir, run.run_id); // external status flip
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "cancelled");
    assert.ok(result.progress.completed < result.progress.total);
    assert.equal(n, 2, "no rollout ran after the cancel flip");
    const events = readEvents(dir);
    assert.equal(events.at(-1).type, "run_cancelled");
  });

  it("surfaces a hard arm failure as status=failed with the error class", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    class HarnessExecutionError extends Error {}
    let first = true;
    const runner = async () => {
      if (first) {
        first = false;
        return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] };
      }
      throw new HarnessExecutionError("mcp version skew: server requires protocol X");
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    // Per-rollout runner throws are absorbed as error ROWS (not a hard fail)…
    assert.equal(result.status, "done");
    const rows = readRows(dir);
    assert.equal(rows.filter((r) => r.status === "error").length, 1);
    assert.match(rows.find((r) => r.status === "error").error, /HarnessExecutionError: mcp version skew/);
    const events = readEvents(dir);
    assert.ok(events.some((e) => e.type === "rollout_error" && /mcp version skew/.test(e.error)));
  });

  it("fails the whole run when the selection is empty, with an honest error class", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { split: "dev" });
    const result = await executeRunRequest(dir, run.run_id, { runner: async () => ({}) });
    assert.equal(result.status, "failed");
    assert.equal(result.error.class, "EmptySelection");
  });

  it("refuses to execute a non-queued request", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir);
    cancelRunRequest(dir, run.run_id);
    await assert.rejects(() => executeRunRequest(dir, run.run_id, { runner: async () => ({}) }), /cancelled, not queued/);
  });
});

describe("oracleRunner rows → hub projection integration", () => {
  it("scores every task 1.0 via the environment's own scoreState and rows carry replayable writes", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["oracle-arm-a", "oracle-arm-b"] });
    const result = await executeRunRequest(dir, run.run_id, { runner: oracleRunner(), concurrency: 2 });
    assert.equal(result.status, "done");
    const rows = readRows(dir);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.status, "ok");
      assert.equal(row.score, 1);
      assert.equal(row.cost, 0);
      assert.equal(row.subscores.final_state, 1);
      assert.equal(row.subscores.runner_oracle, 1);
      assert.ok(row.writes.length > 0, "writes extension feeds the per-arm accumulation replay");
      assert.ok(typeof row.latency_ms === "number" && row.latency_ms >= 1);
    }
  });
});

describe("incumbent baseline arm + calibration gate", () => {
  it("labels rows arm_kind incumbent/candidate and writes calibration.json from rows + run events", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["gpt-4o", "challenger"], incumbent_models: ["gpt-4o"], calibration_threshold: 0.9 });
    // Incumbent passes t1 (score 1) and fails t2 (score 0.5 < 0.9); the candidate always passes.
    // Rollouts make a real tool call + journal entry so the structural sentinels stay quiet.
    const runner = async ({ model, task, journalPath }) => {
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ at: Date.now() / 1000, kind: "call", tool: "update-record", status: "ok" }) + "\n");
      return {
        score: model === "gpt-4o" && task.task_id === "t2" ? 0.5 : 1,
        subscores: null,
        status: "ok",
        latency_ms: 1,
        cost: 0,
        writes: [{ tool: "update-record", arguments: { id: "r1" } }],
        tool_call_count: 1,
      };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");

    const rows = readRows(dir);
    assert.ok(rows.every((r) => ["incumbent", "candidate"].includes(r.arm_kind)));
    assert.ok(rows.filter((r) => r.model === "gpt-4o").every((r) => r.arm_kind === "incumbent"));
    assert.ok(rows.filter((r) => r.model === "challenger").every((r) => r.arm_kind === "candidate"));

    const calibration = JSON.parse(fs.readFileSync(path.join(dir, "calibration.json"), "utf8"));
    assert.equal(calibration.schema_version, "understudy.calibration.v1");
    assert.equal(calibration.benchmark_id, "exec-bench");
    assert.equal(calibration.run_id, run.run_id);
    assert.deepEqual(calibration.incumbent_models, ["gpt-4o"]);
    assert.equal(calibration.threshold, 0.9);
    assert.equal(calibration.passed_count, 1);
    assert.equal(calibration.failed_count, 1);
    assert.deepEqual(calibration.failed_task_ids, ["t2"]);
    // Timestamps come from run events, never a fresh clock read.
    const events = readEvents(dir).filter((e) => e.run_id === run.run_id);
    assert.equal(calibration.started_at, events.find((e) => e.type === "run_started").ts);
    assert.equal(calibration.finished_at, events.find((e) => e.type === "run_finished").ts);
  });

  it("marks every row candidate and writes no calibration when no incumbent is declared", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    await executeRunRequest(dir, run.run_id, { runner: oracleRunner() });
    assert.ok(readRows(dir).every((r) => r.arm_kind === "candidate"));
    assert.equal(fs.existsSync(path.join(dir, "calibration.json")), false);
    // Additive contract: the queued request file omits the new fields entirely.
    assert.ok(!("incumbent_models" in readRunRequest(runRequestPath(dir, run.run_id))));
  });

  it("validates incumbent_models subset + calibration_threshold range", () => {
    const known = ["t1", "t2"];
    const base = { models: ["a", "b"], split: "all", tasks: "all", rollouts_per_task: 1 };
    assert.deepEqual(validateRunRequestInput({ ...base, incumbent_models: ["a"], calibration_threshold: 0.8 }, known), []);
    assert.ok(validateRunRequestInput({ ...base, incumbent_models: ["nope"] }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, incumbent_models: "a" }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, calibration_threshold: 0 }, known).length > 0);
    assert.ok(validateRunRequestInput({ ...base, calibration_threshold: 1.5 }, known).length > 0);
  });

  it("deriveCalibrationSummary fails tasks with no ok incumbent row and defaults the threshold to 1", async () => {
    const { deriveCalibrationSummary } = await import("../dist/run-executor.js");
    const summary = deriveCalibrationSummary({
      benchmarkId: "b",
      runId: "run-x",
      incumbentModels: ["inc"],
      selectedTaskIds: ["t1", "t2", "t3"],
      rows: [
        { run_id: "run-x", model: "inc", task_id: "t1", status: "ok", score: 1 },
        { run_id: "run-x", model: "inc", task_id: "t2", status: "error", score: null },
        { run_id: "run-x", model: "other-candidate", task_id: "t3", status: "ok", score: 1 },
        { run_id: "run-other", model: "inc", task_id: "t3", status: "ok", score: 1 },
      ],
      events: [
        { run_id: "run-x", type: "run_started", ts: "2026-07-22T00:00:00Z" },
        { run_id: "run-other", type: "run_finished", ts: "2026-07-22T09:00:00Z" },
      ],
    });
    assert.equal(summary.threshold, 1);
    assert.deepEqual(summary.failed_task_ids, ["t2", "t3"]);
    assert.equal(summary.started_at, "2026-07-22T00:00:00Z");
    assert.equal(summary.finished_at, null, "other runs' events never leak in");
    assert.equal(summary.tasks.find((t) => t.task_id === "t1").passed, true);
  });

  it("anomaly-flagged incumbent rows never enter the calibration best score (same discipline as the leaderboard)", async () => {
    const { deriveCalibrationSummary } = await import("../dist/run-executor.js");
    const summary = deriveCalibrationSummary({
      benchmarkId: "b",
      runId: "run-x",
      incumbentModels: ["inc"],
      selectedTaskIds: ["t1", "t2"],
      rows: [
        // t1: the only passing rollout is sentinel-flagged — indistinguishable from a harness artifact, so the task fails.
        { run_id: "run-x", model: "inc", task_id: "t1", status: "ok", score: 1, anomaly: { kind: "no_tool_calls", detail: "x" } },
        // t2: a clean pass alongside a flagged zero — the clean row carries the task.
        { run_id: "run-x", model: "inc", task_id: "t2", status: "ok", score: 1 },
        { run_id: "run-x", model: "inc", task_id: "t2", status: "ok", score: 0, anomaly: { kind: "zero_score_zero_calls", detail: "x" } },
      ],
      events: [],
    });
    assert.deepEqual(summary.failed_task_ids, ["t1"]);
    assert.equal(summary.tasks.find((t) => t.task_id === "t1").score, null);
    assert.equal(summary.tasks.find((t) => t.task_id === "t1").anomalous_rollouts, 1);
    assert.equal(summary.tasks.find((t) => t.task_id === "t2").passed, true);
    assert.equal(summary.tasks.find((t) => t.task_id === "t2").anomalous_rollouts, 1);
  });
});

describe("listRunRequests", () => {
  it("lists oldest first and ignores torn/foreign files", () => {
    const dir = makeBenchmarkDir();
    const a = queueRun(dir, { models: ["m1"] }, );
    const b = queueRun(dir, { models: ["m2"] });
    fs.writeFileSync(path.join(dir, "runs", "queue", "junk.json"), "{not json");
    const listed = listRunRequests(dir);
    assert.deepEqual(new Set(listed.map((r) => r.run_id)), new Set([a.run_id, b.run_id]));
  });
});

describe("projectVerifiersTrace (golden fixture from a real pinned-commit eval run)", () => {
  it("maps rewards, usage-derived cost/latency, and prefixed mutating tool calls", async () => {
    const { projectVerifiersTrace } = await import("../dist/run-executor.js");
    const trace = JSON.parse(
      fs.readFileSync(new URL("./fixtures/verifiers-v1-trace-golden.json", import.meta.url), "utf8"),
    );
    const { taskId, result } = projectVerifiersTrace(trace, "glm-5.2");
    assert.equal(taskId, "task-3a357aaff5cc6da9");
    assert.equal(result.status, "ok");
    assert.equal(result.score, 0); // real model attempt scored by the environment
    assert.equal(result.subscores.final_state, 0);
    assert.ok(typeof result.subscores.final_state_partial_credit === "number");
    assert.ok(result.latency_ms > 0, "latency from real call timings");
    assert.ok(result.cost > 0, "estimated cost from real token usage");
    // The mcp server prefix is stripped so writes match the contract's tools.
    assert.deepEqual(result.writes.map((w) => w.tool), ["create-automation"]);
  });
});

describe("live journal wiring", () => {
  it("passes a per-arm journal path to the runner, advertises live on the request file, and clears it at the end", async () => {
    const { liveJournalPath } = await import("../dist/run-executor.js");
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], rollouts_per_task: 1 });
    const seen = { journalPaths: [], liveSnapshots: [] };
    const runner = async ({ journalPath }) => {
      seen.journalPaths.push(journalPath);
      seen.liveSnapshots.push(readRunRequest(runRequestPath(dir, run.run_id)).live);
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [] };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    assert.equal(result.live, null, "live cleared at terminal state");
    assert.equal(seen.journalPaths.length, 2);
    assert.equal(seen.journalPaths[0], liveJournalPath(dir, run.run_id, "m1"));
    for (const live of seen.liveSnapshots) {
      assert.equal(live.model, "m1");
      assert.ok(live.journal.startsWith("runs/live/"), "journal path advertised relative to the benchmark dir");
      assert.ok(["t1", "t2"].includes(live.task_id));
    }
  });

  it("oracle runner journals call+result lines as it executes (zero-cost live proof)", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["oracle-live"], rollouts_per_task: 1 });
    const result = await executeRunRequest(dir, run.run_id, { runner: oracleRunner() });
    assert.equal(result.status, "done");
    const journal = path.join(dir, "runs", "live", `${run.run_id}-oracle-live.jsonl`);
    assert.ok(fs.existsSync(journal), "journal file written");
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.kind === "call" && l.write === true));
    assert.ok(lines.some((l) => l.kind === "result" && l.status === "ok"));
    assert.equal(lines.length, 4); // 2 tasks × (call + result)
  });
});

describe("rollout anomaly sentinels (the silent-zero gate)", () => {
  let detectRolloutAnomalies;
  let VERIFIERS_MAX_EXAMPLES;
  it("loads the sentinel exports", async () => {
    ({ detectRolloutAnomalies, VERIFIERS_MAX_EXAMPLES } = await import("../dist/run-executor.js"));
    assert.equal(typeof detectRolloutAnomalies, "function");
    assert.ok(Number.isInteger(VERIFIERS_MAX_EXAMPLES));
  });

  const stateTask = {
    task_id: "t1",
    title: "Set record active",
    outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "r1" } }] },
  };
  const okResult = (over = {}) => ({
    score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0,
    writes: [{ tool: "update-record", arguments: { id: "r1" } }], tool_call_count: 1, ...over,
  });

  it("clean rollout: no anomalies", () => {
    const anomalies = detectRolloutAnomalies({
      task: stateTask,
      result: okResult(),
      promptSent: "Please set record r1 active in the synthetic project board today.",
      storedPrompt: "Please set record r1 active in the synthetic project board today.",
      journalBytes: 512,
    });
    assert.deepEqual(anomalies, []);
  });

  it("(a) empty prompt and display-title-instead-of-prompt both flag empty_prompt", () => {
    const empty = detectRolloutAnomalies({ task: stateTask, result: okResult(), promptSent: "  " });
    assert.deepEqual(empty.map((a) => a.kind), ["empty_prompt"]);
    const titled = detectRolloutAnomalies({
      task: stateTask,
      result: okResult(),
      promptSent: "Set record active",
      storedPrompt: "A very long stored task prompt that the environment should have carried through verbatim.",
    });
    assert.equal(titled[0].kind, "empty_prompt");
    assert.match(titled[0].detail, /display title/);
  });

  it("(b) zero tool calls on a state-effect contract flags no_tool_calls", () => {
    const anomalies = detectRolloutAnomalies({ task: stateTask, result: okResult({ writes: [], tool_call_count: 0 }) });
    assert.ok(anomalies.some((a) => a.kind === "no_tool_calls"));
  });

  it("(c) empty final response with response obligations flags empty_final_response; unknown (null) never does", () => {
    const task = { task_id: "t9", title: "x", outcome_contract: { required: [{ type: "response_obligation", kind: "json_parses" }] } };
    const flagged = detectRolloutAnomalies({ task, result: okResult({ final_response_chars: 0 }) });
    assert.ok(flagged.some((a) => a.kind === "empty_final_response"));
    const unknown = detectRolloutAnomalies({ task, result: okResult({ final_response_chars: null }) });
    assert.ok(!unknown.some((a) => a.kind === "empty_final_response"));
  });

  it("(d) zero journal bytes on a completed rollout flags no_journal_events", () => {
    const anomalies = detectRolloutAnomalies({ task: stateTask, result: okResult(), journalBytes: 0 });
    assert.deepEqual(anomalies.map((a) => a.kind), ["no_journal_events"]);
  });

  it("(e) score 0 with zero tool calls flags zero_score_zero_calls", () => {
    const anomalies = detectRolloutAnomalies({
      task: { task_id: "t2", title: "x", outcome_contract: { required: [{ type: "response_obligation", kind: "json_parses" }] } },
      result: okResult({ score: 0, writes: [], tool_call_count: 0, final_response_chars: 12 }),
    });
    assert.deepEqual(anomalies.map((a) => a.kind), ["zero_score_zero_calls"]);
  });

  it("error rollouts skip the completed-rollout sentinels (already untrusted)", () => {
    const anomalies = detectRolloutAnomalies({
      task: stateTask,
      result: okResult({ status: "error", score: null, writes: [], tool_call_count: 0 }),
      journalBytes: 0,
    });
    assert.deepEqual(anomalies, []);
  });

  it("executor marks anomalous rows + events but never drops them", async () => {
    const dir = makeBenchmarkDir();
    // Generated-environment task rows: t1's prompt is empty (a silent zero at the source).
    const pkg = path.join(dir, "environment", "understudy_trace_env");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "tasks.json"),
      JSON.stringify([
        { task_id: "t1", prompt: "", source_messages: [{ role: "user", content: "Full original user request with plenty of detail" }] },
        { task_id: "t2", prompt: "Full original user request with plenty of detail", source_messages: [{ role: "user", content: "Full original user request with plenty of detail" }] },
      ]),
    );
    const run = queueRun(dir, { models: ["m1"], rollouts_per_task: 1, split: "all" });
    // Runner completes "ok" with zero calls and zero score — a classic silent zero.
    const runner = async () => ({ score: 0, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [], tool_call_count: 0 });
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    const rows = readRows(dir);
    assert.equal(rows.length, 2, "anomalous rows are written, never dropped");
    for (const row of rows) {
      assert.ok(row.anomaly, "row carries the primary anomaly");
      assert.ok(Array.isArray(row.anomalies) && row.anomalies.length > 0);
      const kinds = row.anomalies.map((a) => a.kind);
      assert.ok(kinds.includes("no_tool_calls"));
      assert.ok(kinds.includes("zero_score_zero_calls"));
      assert.ok(kinds.includes("no_journal_events"), "no journal was ever written");
      if (row.task_id === "t1") assert.ok(kinds.includes("empty_prompt"));
    }
    const events = fs
      .readFileSync(path.join(dir, "runs", "events.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l))
      .filter((e) => e.run_id === run.run_id && e.type === "rollout");
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.anomaly && typeof e.anomaly.kind === "string"), "rollout events carry the anomaly");
  });

  it("emits an explicit cap_warning event when the selection exceeds the per-arm eval cap", async () => {
    const { VERIFIERS_MAX_EXAMPLES: cap, createRunRequest: create } = await import("../dist/run-executor.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-exec-cap-"));
    roots.push(dir);
    const taskIds = Array.from({ length: cap + 1 }, (_, i) => `task-${i}`);
    fs.writeFileSync(
      path.join(dir, "benchmark.json"),
      JSON.stringify({
        schema_version: "understudy.benchmark.v1",
        benchmark_id: "cap-bench",
        provenance: { origin: "derived-from-traces" },
        taxonomy: [{ category_id: "cat-a" }],
        tasks: taskIds.map((task_id) => ({ task_id, category_id: "cat-a", genesis: "replayed", split: "train" })),
        environment: { format: "verifiers.v1", package_ref: "environment" },
        verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
      }),
    );
    fs.writeFileSync(path.join(dir, "tasks.jsonl"), "");
    const run = create(dir, { benchmark_id: "cap-bench", models: ["m1"], split: "all", tasks: "all", rollouts_per_task: 1 });
    const events = [];
    const runner = async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-x", arguments: {} }], tool_call_count: 1 });
    const result = await executeRunRequest(dir, run.run_id, { runner, concurrency: 8, onEvent: (e) => events.push(e) });
    assert.equal(result.status, "done");
    const warning = events.find((e) => e.type === "cap_warning");
    assert.ok(warning, "cap_warning event recorded when the cap binds");
    assert.match(warning.warning, new RegExp(String(cap)));
  });
});

describe("oracle full-contract coverage (response obligations vs stored gold)", () => {
  /** Benchmark dir with one task carrying state + response + value obligations; gold optional. */
  function makeResponseBenchmarkDir({ withGold }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-exec-gold-"));
    roots.push(dir);
    fs.writeFileSync(
      path.join(dir, "benchmark.json"),
      JSON.stringify({
        schema_version: "understudy.benchmark.v1",
        benchmark_id: "gold-bench",
        provenance: { origin: "derived-from-traces" },
        taxonomy: [{ category_id: "cat-a" }],
        tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "train" }],
        environment: { format: "verifiers.v1", package_ref: "environment" },
        verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
      }),
    );
    const sidecar = {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      source: { node_ids: ["cap-1"] },
      outcome_contract: {
        required: [
          { type: "state_effect", tool: "update-record", observed_arguments: { id: "r1" } },
          { type: "response_obligation", kind: "contains_category", expected: "external_customer" },
          { type: "value_propagation", source: { kind: "prompt" }, value: "Jordan Doe", must_reach: { kind: "final_response" } },
        ],
        preserved: [],
        forbidden: [],
        grading: "final_state_and_obligations",
      },
    };
    fs.writeFileSync(path.join(dir, "tasks.jsonl"), JSON.stringify(sidecar) + "\n");
    if (withGold) {
      const capture = {
        schema_version: "understudy.normalized_capture.v1",
        capture_key: "cap-1",
        capture_id: "cap-1",
        response: { body: { content: [{ type: "text", text: "Jordan Doe is an external_customer contact." }] } },
      };
      fs.writeFileSync(path.join(dir, "normalized-captures.jsonl"), JSON.stringify(capture) + "\n");
    }
    return dir;
  }

  it("scores 1.0 on EVERY obligation kind when the stored gold final response is present", async () => {
    const dir = makeResponseBenchmarkDir({ withGold: true });
    const run = createRunRequest(dir, { benchmark_id: "gold-bench", models: ["oracle"], split: "all", tasks: "all", rollouts_per_task: 1 });
    const result = await executeRunRequest(dir, run.run_id, { runner: oracleRunner() });
    assert.equal(result.status, "done");
    const rows = readRows(dir);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.status, "ok");
    assert.equal(row.score, 1, "full-contract oracle strict score (state + response + value)");
    assert.equal(row.subscores.runner_oracle, 1);
    assert.equal(row.oracle, undefined, "gold present — no missing-gold diagnostic");
    assert.ok(row.final_response_chars > 0, "the gold final response is the oracle's response");
    assert.ok(row.writes.length === 1 && row.writes[0].tool === "update-record", "writes stay the contract's state effects");
  });

  it("records oracle.missing_gold (unverifiable, not broken) when the gold response is absent from the artifacts", async () => {
    const dir = makeResponseBenchmarkDir({ withGold: false });
    const run = createRunRequest(dir, { benchmark_id: "gold-bench", models: ["oracle"], split: "all", tasks: "all", rollouts_per_task: 1 });
    const result = await executeRunRequest(dir, run.run_id, { runner: oracleRunner() });
    assert.equal(result.status, "done");
    const row = readRows(dir)[0];
    assert.equal(row.status, "ok");
    assert.equal(row.score, 0, "response obligations cannot be verified without gold — the task flips to not-runnable");
    assert.deepEqual(row.oracle, { missing_gold: ["response"] }, "distinct diagnostic so the hub renders unverifiable, not broken");
    assert.equal(row.final_response_chars, undefined, "unknown final response is never persisted as 0 chars");
  });
});

describe("claim / skip / takeover (stale-watcher hijack guard)", () => {
  let claimRunRequest, pidAlive, EXECUTOR_VERSION;
  it("loads the claim exports", async () => {
    ({ claimRunRequest, pidAlive, EXECUTOR_VERSION } = await import("../dist/run-executor.js"));
    assert.equal(typeof claimRunRequest, "function");
    assert.ok(pidAlive(process.pid));
  });

  /** A pid that definitely ran and definitely exited. */
  function deadPid() {
    const child = spawnSync("true");
    assert.ok(child.pid > 0);
    return child.pid;
  }

  const okRunner = async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: {} }], tool_call_count: 1 });

  it("claims an unclaimed queued request and verifies its own nonce landed", () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir);
    const claimed = claimRunRequest(dir, run.run_id);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.claim.pid, process.pid);
    assert.equal(claimed.claim.executor_version, EXECUTOR_VERSION);
    const persisted = readRunRequest(runRequestPath(dir, run.run_id));
    assert.equal(persisted.claimed_by.nonce, claimed.claim.nonce, "claim persisted on the request file");
  });

  it("skips a request claimed by a LIVE foreign pid (both claim + execute paths)", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    const first = claimRunRequest(dir, run.run_id, { pid: process.pid });
    assert.equal(first.ok, true);
    const second = claimRunRequest(dir, run.run_id, { pid: process.pid + 1 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "claimed");
    // executeRunRequest with a different pid must not run a single rollout.
    let calls = 0;
    const result = await executeRunRequest(dir, run.run_id, { runner: async () => { calls += 1; return okRunner(); }, pid: process.pid + 1 });
    assert.equal(result.status, "queued", "request stays queued for the claiming executor");
    assert.equal(calls, 0, "no rollout ran under a foreign live claim");
  });

  it("takes over a claim whose pid is dead (staleness takeover) and runs to done", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    const stale = claimRunRequest(dir, run.run_id, { pid: deadPid() });
    assert.equal(stale.ok, true, "the dead pid claims first (simulating a crashed executor)");
    const result = await executeRunRequest(dir, run.run_id, { runner: okRunner });
    assert.equal(result.status, "done", "a dead claim never wedges the queue");
    assert.equal(readRunRequest(runRequestPath(dir, run.run_id)).claimed_by.pid, process.pid);
  });

  it("re-claiming with the SAME pid is allowed (resume after an interrupted start)", () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir);
    assert.equal(claimRunRequest(dir, run.run_id).ok, true);
    assert.equal(claimRunRequest(dir, run.run_id).ok, true);
  });

  it("executeQueuedRuns skips claimed requests without reporting them as results", async () => {
    const { executeQueuedRuns } = await import("../dist/run-executor.js");
    const dir = makeBenchmarkDir();
    const claimedRun = queueRun(dir, { models: ["m1"] });
    claimRunRequest(dir, claimedRun.run_id, { pid: process.pid });
    const freeRun = queueRun(dir, { models: ["m2"] });
    const results = await executeQueuedRuns(dir, { runner: okRunner, pid: process.pid + 1 });
    assert.deepEqual(results.map((r) => r.run_id), [freeRun.run_id]);
    assert.equal(readRunRequest(runRequestPath(dir, claimedRun.run_id)).status, "queued");
  });
});

describe("capability gate (requires) + executor_version attribution", () => {
  const okRunner = async () => ({ score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: {} }], tool_call_count: 1 });

  it("createRunRequest populates requires for the features actually used, and omits it otherwise", () => {
    const dir = makeBenchmarkDir();
    const plain = queueRun(dir, { models: ["m1"] });
    assert.ok(!("requires" in readRunRequest(runRequestPath(dir, plain.run_id))), "old shape stays exact when no feature is used");
    const featured = queueRun(dir, { models: ["m1"], incumbent_models: ["m1"], trivial_arms: ["null_agent"], rollout_timeout_seconds: 60 });
    assert.deepEqual(readRunRequest(runRequestPath(dir, featured.run_id)).requires.sort(), ["calibration", "rollout_timeout", "trivial_arms"]);
  });

  it("skips a request requiring an unknown capability with a recorded run_unsupported note — never silently drops fields", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    // Simulate a NEWER writer: a capability this executor build does not know.
    const file = runRequestPath(dir, run.run_id);
    fs.writeFileSync(file, JSON.stringify({ ...readRunRequest(file), requires: ["holographic_arms"] }));
    let calls = 0;
    const result = await executeRunRequest(dir, run.run_id, { runner: async () => { calls += 1; return okRunner(); } });
    assert.equal(result.status, "queued", "stays queued for a capable executor");
    assert.equal(calls, 0, "nothing executed");
    assert.deepEqual(result.unsupported.missing, ["holographic_arms"]);
    const events = readEvents(dir).filter((e) => e.run_id === run.run_id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "run_unsupported");
    assert.match(events[0].error, /holographic_arms/);
    // A polling watch daemon must not spam duplicate notes.
    await executeRunRequest(dir, run.run_id, { runner: okRunner });
    assert.equal(readEvents(dir).filter((e) => e.type === "run_unsupported").length, 1);
  });

  it("simulated OLD executor (narrow capability set) skips a trivial-arms request instead of hijacking it", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], trivial_arms: ["null_agent", "spam_agent"] });
    const result = await executeRunRequest(dir, run.run_id, { runner: okRunner, capabilities: [] });
    assert.equal(result.status, "queued");
    assert.deepEqual(result.unsupported.missing, ["trivial_arms"]);
    assert.equal(readRows(dir).length, 0, "the old executor produced no unlabeled rows");
    // A current executor then runs it fully, trivial arms included.
    const done = await executeRunRequest(dir, run.run_id, { runner: okRunner });
    assert.equal(done.status, "done");
    const kinds = new Set(readRows(dir).map((r) => r.arm_kind));
    assert.ok(kinds.has("null_agent") && kinds.has("spam_agent"));
  });

  it("old-shape requests (no requires) execute exactly as before", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    const result = await executeRunRequest(dir, run.run_id, { runner: okRunner });
    assert.equal(result.status, "done");
  });

  it("stamps executor_version on every row and event (degraded-run attribution)", async () => {
    const { EXECUTOR_VERSION } = await import("../dist/run-executor.js");
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(EXECUTOR_VERSION, pkg.version);
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"] });
    await executeRunRequest(dir, run.run_id, { runner: okRunner });
    assert.ok(readRows(dir).every((r) => r.executor_version === EXECUTOR_VERSION));
    assert.ok(readEvents(dir).every((e) => e.executor_version === EXECUTOR_VERSION));
  });

  it("validates rollout_timeout_seconds", () => {
    const base = { models: ["a"], split: "all", tasks: "all", rollouts_per_task: 1 };
    assert.deepEqual(validateRunRequestInput({ ...base, rollout_timeout_seconds: 600 }, ["t1"]), []);
    assert.ok(validateRunRequestInput({ ...base, rollout_timeout_seconds: 0 }, ["t1"]).length > 0);
    assert.ok(validateRunRequestInput({ ...base, rollout_timeout_seconds: "600" }, ["t1"]).length > 0);
  });
});

describe("per-rollout timeout → rollout_timeout anomaly row", () => {
  it("kills a hung rollout at the request's rollout_timeout_seconds, marks the row, and continues the run", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], rollout_timeout_seconds: 0.05 });
    // t1 hangs (simulating the ~30min open-gateway-connection hang); t2 is fine.
    const runner = async ({ task, journalPath }) => {
      if (task.task_id === "t1") await new Promise((r) => setTimeout(r, 60_000).unref());
      if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ at: Date.now() / 1000, kind: "call", tool: "create-item", status: "ok" }) + "\n");
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "create-item", arguments: {} }], tool_call_count: 1 };
    };
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done", "the run continues past the hang");
    const rows = readRows(dir);
    assert.equal(rows.length, 2, "the timed-out rollout is recorded, never dropped");
    const hung = rows.find((r) => r.task_id === "t1");
    assert.equal(hung.status, "error");
    assert.equal(hung.anomaly.kind, "rollout_timeout");
    assert.match(hung.error, /rollout_timeout/);
    const fine = rows.find((r) => r.task_id === "t2");
    assert.equal(fine.status, "ok");
    assert.equal(fine.anomaly, undefined);
    // The anomaly rides the rollout event too.
    const events = readEvents(dir).filter((e) => e.run_id === run.run_id);
    assert.ok(events.some((e) => e.type === "rollout_error" && e.anomaly?.kind === "rollout_timeout"));
  });

  it("executor-flag timeout applies when the request carries none; request-level wins over the flag", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], tasks: ["t1"], rollout_timeout_seconds: 5 });
    const seen = [];
    const runner = async ({ rolloutTimeoutSeconds }) => {
      seen.push(rolloutTimeoutSeconds);
      return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: 0, writes: [{ tool: "update-record", arguments: {} }], tool_call_count: 1 };
    };
    await executeRunRequest(dir, run.run_id, { runner, rolloutTimeoutSeconds: 99 });
    assert.deepEqual(seen, [5], "the request's rollout_timeout_seconds wins and is handed to the runner");
    const { DEFAULT_ROLLOUT_TIMEOUT_SECONDS } = await import("../dist/run-executor.js");
    const run2 = queueRun(dir, { models: ["m2"], tasks: ["t1"] });
    seen.length = 0;
    await executeRunRequest(dir, run2.run_id, { runner });
    assert.deepEqual(seen, [DEFAULT_ROLLOUT_TIMEOUT_SECONDS], "generous default when neither request nor flag sets one");
  });

  it("a runner reporting timed_out (subprocess killed inside the runner) gets the same anomaly", async () => {
    const dir = makeBenchmarkDir();
    const run = queueRun(dir, { models: ["m1"], tasks: ["t1"] });
    const runner = async () => ({ score: null, subscores: null, status: "error", latency_ms: 1000, cost: null, writes: [], timed_out: true, error: "rollout_timeout: verifiers eval killed" });
    const result = await executeRunRequest(dir, run.run_id, { runner });
    assert.equal(result.status, "done");
    assert.equal(readRows(dir)[0].anomaly.kind, "rollout_timeout");
  });
});

describe("per-invocation output isolation (cross-run trace attribution)", () => {
  let verifiersWorkDir, newOutputFiles;
  it("loads the isolation exports", async () => {
    ({ verifiersWorkDir, newOutputFiles } = await import("../dist/run-executor.js"));
    assert.equal(typeof verifiersWorkDir, "function");
  });

  const writeTrace = (root, model, taskId) => {
    const out = path.join(root, "outputs", `understudy-trace-env--${model}--bash`);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "traces.jsonl"), JSON.stringify({ traces: [{ task: { data: { task_id: taskId } }, rewards: { final_state: 1 }, ok: true }] }) + "\n");
  };

  it("run_id + arm are in the work-dir path, and paths are unique per invocation", () => {
    const dir = makeBenchmarkDir();
    const a = verifiersWorkDir(dir, "run-aaa--gemma-4");
    const b = verifiersWorkDir(dir, "run-bbb--gemma-4");
    assert.notEqual(a, b);
    assert.match(a, /runs\/work\/run-aaa--gemma-4$/);
    assert.ok(a.startsWith(path.resolve(dir)));
  });

  it("two simulated CONCURRENT same-model invocations never cross-read each other's traces (structural, not mtime)", () => {
    const dir = makeBenchmarkDir();
    const workA = verifiersWorkDir(dir, "run-aaa--gemma-4");
    const workB = verifiersWorkDir(dir, "run-bbb--gemma-4");
    // Both write concurrently (identical mtimes — the exact hazard) for the SAME model.
    writeTrace(workA, "gemma-4", "task-from-run-A");
    writeTrace(workB, "gemma-4", "task-from-run-B");
    const filesA = newOutputFiles(workA, 0);
    const filesB = newOutputFiles(workB, 0);
    assert.equal(filesA.length, 1);
    assert.equal(filesB.length, 1);
    assert.ok(filesA[0].includes("run-aaa--gemma-4") && !filesA[0].includes("run-bbb"));
    assert.ok(filesB[0].includes("run-bbb--gemma-4") && !filesB[0].includes("run-aaa"));
    assert.equal(JSON.parse(fs.readFileSync(filesA[0], "utf8")).traces[0].task.data.task_id, "task-from-run-A");
  });

  it("keeps reading the legacy shared-outputs layout (backward compatible)", () => {
    const dir = makeBenchmarkDir();
    writeTrace(dir, "gemma-4", "legacy-task");
    const files = newOutputFiles(dir, 0);
    assert.equal(files.length, 1);
    assert.match(files[0], /outputs\/understudy-trace-env--gemma-4--bash\/traces\.jsonl$/);
  });
});
