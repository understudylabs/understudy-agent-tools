import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createRunRequest, executeRunRequest, runEventsPath } from "../dist/run-executor.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
const tmpdir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

function makeBenchmark(taskCount) {
  const dir = tmpdir("spend-bench-");
  const ids = Array.from({ length: taskCount }, (_, i) => `t${i + 1}`);
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "spend-bench",
      tasks: ids.map((task_id) => ({ task_id, category_id: "cat", split: "train" })),
    }),
  );
  fs.writeFileSync(
    path.join(dir, "tasks.jsonl"),
    ids
      .map((task_id) =>
        JSON.stringify({
          schema_version: "understudy.benchmark_task.v1",
          task_id,
          title: `task ${task_id}`,
          outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "r-1" } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
        }),
      )
      .join("\n") + "\n",
  );
  return dir;
}

const posture = (overrides) => ({ schema_version: "understudy.trust_posture.v1", level: "bounded_experiments", set_at: null, overrides });

const costingRunner = (usdPerRollout) => async ({ journalPath }) => {
  if (journalPath) fs.appendFileSync(journalPath, JSON.stringify({ kind: "call", tool: "update-record", status: "ok" }) + "\n");
  return { score: 1, subscores: null, status: "ok", latency_ms: 1, cost: usdPerRollout, writes: [{ tool: "update-record", arguments: { id: "r-1" } }] };
};

const events = (dir) => fs.readFileSync(runEventsPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("posture spend stop-loss (stop-loss doctrine: warn, don't kill)", () => {
  it("no posture stop-loss = no cap: nothing warns, nothing stops, no spend stamp", async () => {
    const dir = makeBenchmark(3);
    const run = createRunRequest(dir, { benchmark_id: "spend-bench", models: ["gw"], split: "all", tasks: "all", rollouts_per_task: 1 });
    const result = await executeRunRequest(dir, run.run_id, { runner: costingRunner(100), trustPosture: posture({}) });
    assert.equal(result.status, "done");
    assert.equal(result.progress.completed, 3, "every rollout ran despite huge recorded costs");
    assert.ok(!("spend" in result), "no stop-loss, no spend stamp");
    assert.ok(!events(dir).some((e) => e.type === "spend_warning" || e.type === "spend_stop"));
  });

  it("warn path: crossing 1x records a spend_warning and the run CONTINUES to completion", async () => {
    const dir = makeBenchmark(4);
    const run = createRunRequest(dir, { benchmark_id: "spend-bench", models: ["gw"], split: "all", tasks: "all", rollouts_per_task: 1 });
    // 4 x $1 = $4 total; stop-loss $3: warned at the 3rd rollout, 2x ($6) never reached.
    const result = await executeRunRequest(dir, run.run_id, { runner: costingRunner(1), trustPosture: posture({ allow_spend_usd_per_run: 3 }), concurrency: 1 });
    assert.equal(result.status, "done");
    assert.equal(result.progress.completed, 4, "warn-at-threshold never kills the run");
    const warnings = events(dir).filter((e) => e.type === "spend_warning");
    assert.equal(warnings.length, 1, "warned exactly once");
    assert.match(warnings[0].warning, /stop-loss threshold of \$3\.00/);
    assert.match(warnings[0].warning, /run continues/);
    assert.ok(!events(dir).some((e) => e.type === "spend_stop"));
    assert.deepEqual(result.spend, { recorded_usd: 4, stop_loss_usd: 3, warned: true, stopped: false });
  });

  it("hard stop only at 2x: remaining rollouts stop, completed rows are kept, everything is recorded", async () => {
    const dir = makeBenchmark(10);
    const run = createRunRequest(dir, { benchmark_id: "spend-bench", models: ["gw"], split: "all", tasks: "all", rollouts_per_task: 1 });
    // $1/rollout, stop-loss $2: warn at $2, stop at $4 — never a mid-run kill below 2x.
    const result = await executeRunRequest(dir, run.run_id, { runner: costingRunner(1), trustPosture: posture({ allow_spend_usd_per_run: 2 }), concurrency: 1 });
    assert.equal(result.status, "done", "a spend stop is a recorded early finish, not a failure");
    assert.equal(result.progress.completed, 4, "stopped exactly at 2x the stop-loss");
    assert.ok(events(dir).some((e) => e.type === "spend_warning"));
    const stop = events(dir).find((e) => e.type === "spend_stop");
    assert.match(stop.error, /2x the posture stop-loss/);
    assert.deepEqual(result.spend, { recorded_usd: 4, stop_loss_usd: 2, warned: true, stopped: true });
  });
});
