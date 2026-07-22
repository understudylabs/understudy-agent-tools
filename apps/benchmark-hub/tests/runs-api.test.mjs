import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { GET, POST } from "./.build/app/api/runs/route.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-runs-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
// Demo mode ON so the repo's read-only fixture entries are reachable.
process.env.BENCHMARK_HUB_DEMO = "1";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dir = path.join(tmp, "runnable");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "runnable-bench",
    provenance: { origin: "derived-from-traces" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [
      { task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "holdout" },
      { task_id: "t2", category_id: "cat-a", genesis: "replayed", split: "train" },
    ],
    environment: { format: "verifiers.v1", package_ref: "environment" },
    verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
  }),
);

// A proposed (foundry) dir, to prove runs are rejected pre-promotion.
const proposedDir = path.join(tmp, "proposed-only");
fs.mkdirSync(proposedDir, { recursive: true });
fs.writeFileSync(
  path.join(proposedDir, "manifest.json"),
  JSON.stringify({ schema_version: "understudy.trace_foundry.v1", counts: {}, freshness: {} }),
);
fs.writeFileSync(
  path.join(proposedDir, "tasks.jsonl"),
  JSON.stringify({ schema_version: "understudy.benchmark_task.v1", task_id: "p1" }) + "\n",
);

function post(body) {
  return POST(
    new Request("http://localhost/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
function getRuns(slug) {
  return GET(new Request(`http://localhost/api/runs?slug=${encodeURIComponent(slug)}`));
}

describe("POST /api/runs", () => {
  it("rejects a non-JSON body with 400", async () => {
    const res = await post("not json");
    assert.equal(res.status, 400);
  });

  it("rejects an unknown slug with 404", async () => {
    const res = await post({ slug: "data--nope", models: ["m"], split: "all" });
    assert.equal(res.status, 404);
  });

  it("rejects proposed benchmark-LEVEL runs with 400 (single-task only pre-promotion)", async () => {
    const res = await post({ slug: "data--proposed-only", models: ["m"], split: "all" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /single-task/i);
  });

  it("rejects read-only fixture entries with 403", async () => {
    const res = await post({ slug: "fixture--benchmark-derived", models: ["m"], split: "all" });
    assert.equal(res.status, 403);
  });

  it("rejects empty/invalid models with 400", async () => {
    for (const models of [[], ["", "m"], "gpt", [1]]) {
      const res = await post({ slug: "data--runnable", models, split: "all" });
      assert.equal(res.status, 400, JSON.stringify(models));
    }
  });

  it("rejects an unknown split and unknown task ids with 400", async () => {
    const badSplit = await post({ slug: "data--runnable", models: ["m"], split: "prod" });
    assert.equal(badSplit.status, 400);
    const badTask = await post({ slug: "data--runnable", models: ["m"], split: "all", tasks: ["t1", "nope"] });
    assert.equal(badTask.status, 400);
    assert.match((await badTask.json()).error, /unknown task_id: nope/);
  });

  it("rejects out-of-range rollouts_per_task with 400", async () => {
    for (const rollouts of [0, -1, 2.5, 99]) {
      const res = await post({ slug: "data--runnable", models: ["m"], split: "all", rollouts_per_task: rollouts });
      assert.equal(res.status, 400, String(rollouts));
    }
  });

  it("rejects a selection resolving to zero tasks with 400", async () => {
    const res = await post({ slug: "data--runnable", models: ["m"], split: "dev" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /no tasks match/);
  });

  it("queues a valid run request as a file and lists it via GET", async () => {
    const res = await post({ slug: "data--runnable", models: ["model-a", "model-b"], split: "holdout", rollouts_per_task: 2 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run.schema_version, "understudy.run_request.v1");
    assert.equal(body.run.status, "queued");
    assert.equal(body.run.benchmark_id, "runnable-bench");
    assert.deepEqual(body.run.models, ["model-a", "model-b"]);
    assert.match(body.execute_hint, /understudy runs execute/);

    const file = path.join(dir, "runs", "queue", `${body.run.run_id}.json`);
    assert.ok(fs.existsSync(file), "request file written into runs/queue/");

    const list = await (await getRuns("data--runnable")).json();
    assert.ok(list.runs.some((r) => r.run_id === body.run.run_id));
  });

  it("queues an incumbent-baseline run: incumbent_models pass through additively", async () => {
    const res = await post({
      slug: "data--runnable",
      models: ["gpt-4o", "candidate-x"],
      split: "holdout",
      incumbent_models: ["gpt-4o"],
      calibration_threshold: 0.9,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.run.incumbent_models, ["gpt-4o"]);
    assert.equal(body.run.calibration_threshold, 0.9);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "runs", "queue", `${body.run.run_id}.json`), "utf8"));
    assert.deepEqual(onDisk.incumbent_models, ["gpt-4o"]);
  });

  it("rejects incumbent_models outside the run's models and a bad threshold with 400", async () => {
    const notSubset = await post({ slug: "data--runnable", models: ["m"], split: "all", incumbent_models: ["other"] });
    assert.equal(notSubset.status, 400);
    assert.match((await notSubset.json()).error, /subset of models/);
    const badThreshold = await post({ slug: "data--runnable", models: ["m"], split: "all", calibration_threshold: 2 });
    assert.equal(badThreshold.status, 400);
  });

  it("plain queue requests keep the exact prior shape (no incumbent fields)", async () => {
    const res = await post({ slug: "data--runnable", models: ["m"], split: "all" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!("incumbent_models" in body.run));
    assert.ok(!("calibration_threshold" in body.run));
  });

  it("cancels a queued run (status flip) and rejects double-cancel with 409", async () => {
    const queued = await (await post({ slug: "data--runnable", models: ["m"], split: "all" })).json();
    const cancel = await post({ slug: "data--runnable", action: "cancel", run_id: queued.run.run_id });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).run.status, "cancelled");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "runs", "queue", `${queued.run.run_id}.json`), "utf8"));
    assert.equal(onDisk.status, "cancelled");

    const again = await post({ slug: "data--runnable", action: "cancel", run_id: queued.run.run_id });
    assert.equal(again.status, 409);
  });

  it("rejects cancel of an unknown run_id with 404 and a traversal-ish id with 400", async () => {
    const missing = await post({ slug: "data--runnable", action: "cancel", run_id: "run-doesnotexist00" });
    assert.equal(missing.status, 404);
    const traversal = await post({ slug: "data--runnable", action: "cancel", run_id: "../escape" });
    assert.equal(traversal.status, 400);
  });
});

/* ---- Proposed per-task run gating: accepted + validated env unlocks a
   single-task run pre-promotion; everything else is refused clearly. ---- */

/** A full proposed foundry dir with reviewable tasks and (optionally) a validated env. */
function makeProposedDir(name, { reviews = [], withEnv = true, oracleStrict = 1 } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ schema_version: "understudy.trace_foundry.v1", counts: {}, freshness: {} }),
  );
  const tasks = ["p1", "p2"].map((id) => ({
    schema_version: "understudy.benchmark_task.v1",
    task_id: id,
    outcome_contract: { required: [{ tool: "update-x", observed_arguments: { id } }], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
  }));
  fs.writeFileSync(path.join(dir, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
  // Proposal-stamped benchmark.json: the executor accepts it and rows carry its id.
  fs.writeFileSync(
    path.join(dir, "benchmark.json"),
    JSON.stringify({ schema_version: "understudy.benchmark_proposal.v1", benchmark_id: `prop-${name}`, tasks: tasks.map((t) => ({ task_id: t.task_id, split: "train" })) }),
  );
  if (reviews.length > 0) {
    fs.writeFileSync(
      path.join(dir, "reviews.jsonl"),
      reviews
        .map((r) =>
          JSON.stringify({
            schema_version: "understudy.benchmark_review.v1",
            benchmark_id: name,
            task_id: r.task_id,
            decision: r.decision,
            note: "",
            created_at: new Date().toISOString(),
          }),
        )
        .join("\n") + "\n",
    );
  }
  if (withEnv) {
    fs.mkdirSync(path.join(dir, "environment"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "environment", "offline-validation.json"),
      JSON.stringify({
        schema_version: "understudy.verifier_validation.v1",
        tasks: ["p1", "p2"].map((id) => ({
          task_id: id,
          oracle: { strict: oracleStrict, score: oracleStrict },
          sentinels: { noop: { strict: 0, score: 0 }, wrong_value: { strict: 0, score: 0 } },
        })),
      }),
    );
  }
  return dir;
}

describe("POST /api/runs — proposed per-task gating matrix", () => {
  it("accepted task + validated environment → 200 and a queued single-task request", async () => {
    const dir = makeProposedDir("prop-ok", { reviews: [{ task_id: "p1", decision: "accept" }] });
    const res = await post({ slug: "data--prop-ok", models: ["m"], tasks: ["p1"], rollouts_per_task: 1 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run.status, "queued");
    assert.deepEqual(body.run.tasks, ["p1"]);
    assert.equal(body.run.benchmark_id, "prop-prop-ok");
    assert.ok(fs.existsSync(path.join(dir, "runs", "queue", `${body.run.run_id}.json`)));
  });

  it("unreviewed task → 403 'task not accepted yet'", async () => {
    makeProposedDir("prop-unreviewed");
    const res = await post({ slug: "data--prop-unreviewed", models: ["m"], tasks: ["p1"] });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not accepted yet.*unreviewed/i);
  });

  it("rejected task → 403 with the decision named", async () => {
    makeProposedDir("prop-rejected", { reviews: [{ task_id: "p1", decision: "reject" }] });
    const res = await post({ slug: "data--prop-rejected", models: ["m"], tasks: ["p1"] });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not accepted yet.*reject/i);
  });

  it("accepted but environment missing → 503 'environment not ready'", async () => {
    makeProposedDir("prop-noenv", { reviews: [{ task_id: "p1", decision: "accept" }], withEnv: false });
    const res = await post({ slug: "data--prop-noenv", models: ["m"], tasks: ["p1"] });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /environment not ready/i);
  });

  it("accepted but oracle validation failing → 503", async () => {
    makeProposedDir("prop-badoracle", { reviews: [{ task_id: "p1", decision: "accept" }], oracleStrict: 0 });
    const res = await post({ slug: "data--prop-badoracle", models: ["m"], tasks: ["p1"] });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /oracle/i);
  });

  it("multi-task and tasks:'all' requests on proposed stay 400", async () => {
    makeProposedDir("prop-multi", { reviews: [{ task_id: "p1", decision: "accept" }, { task_id: "p2", decision: "accept" }] });
    for (const tasks of [["p1", "p2"], "all", undefined]) {
      const res = await post({ slug: "data--prop-multi", models: ["m"], split: "all", tasks });
      assert.equal(res.status, 400, JSON.stringify(tasks));
    }
  });

  it("unknown task id on proposed → 404", async () => {
    makeProposedDir("prop-unknown", { reviews: [{ task_id: "p1", decision: "accept" }] });
    const res = await post({ slug: "data--prop-unknown", models: ["m"], tasks: ["nope"] });
    assert.equal(res.status, 404);
  });

  it("proposed entries load pre-promotion run rows (rows-*.jsonl) with foreign rows dropped", async () => {
    const dir = makeProposedDir("prop-rows", { reviews: [{ task_id: "p1", decision: "accept" }] });
    const row = {
      schema_version: "understudy.eval_result.v1",
      run_id: "run-x",
      task_id: "p1",
      status: "ok",
      score: 1,
      model: "m",
      benchmark_id: "prop-prop-rows",
    };
    const foreign = { ...row, benchmark_id: "someone-else" };
    fs.writeFileSync(path.join(dir, "rows-run-x-m.jsonl"), JSON.stringify(row) + "\n" + JSON.stringify(foreign) + "\n");
    const { getEntry } = await import("./.build/lib/data-core.js");
    const entry = getEntry("data--prop-rows");
    assert.equal(entry.kind, "proposed");
    assert.equal(entry.rows.length, 1);
    assert.equal(entry.rows[0].task_id, "p1");
    assert.equal(entry.diagnostics.foreignRows, 1);
  });
});
