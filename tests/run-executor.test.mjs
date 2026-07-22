import assert from "node:assert/strict";
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
