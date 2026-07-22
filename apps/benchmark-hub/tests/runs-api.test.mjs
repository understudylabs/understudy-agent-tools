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

  it("rejects proposed (unpromoted) benchmarks with 400", async () => {
    const res = await post({ slug: "data--proposed-only", models: ["m"], split: "all" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /promote/i);
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
