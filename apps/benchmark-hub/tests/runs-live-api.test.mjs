import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { GET } from "./.build/app/api/runs/live/route.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-live-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A promoted benchmark with a foundry tasks.jsonl sidecar and a running run.
const dir = path.join(tmp, "livebench");
fs.mkdirSync(path.join(dir, "runs", "queue"), { recursive: true });
fs.mkdirSync(path.join(dir, "runs", "live"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "live-bench",
    provenance: { origin: "derived-from-traces" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "holdout" }],
    environment: { format: "verifiers.v1", package_ref: "environment" },
    verifier: { kind: "final-state", strict_metric: "task_completed_correctly" },
  }),
);
fs.writeFileSync(
  path.join(dir, "tasks.jsonl"),
  JSON.stringify({
    schema_version: "understudy.benchmark_task.v1",
    task_id: "t1",
    outcome_contract: { required: [{ type: "state_effect", tool: "update-record", observed_arguments: { id: "rec-1234567890123456" } }], preserved: [], forbidden: [], grading: "g" },
  }) + "\n",
);
const runId = "run-live0000000001";
fs.writeFileSync(
  path.join(dir, "runs", "queue", `${runId}.json`),
  JSON.stringify({
    schema_version: "understudy.run_request.v1",
    run_id: runId,
    benchmark_id: "live-bench",
    models: ["m1"],
    split: "all",
    tasks: ["t1"],
    rollouts_per_task: 1,
    created_at: "2026-07-22T00:00:00Z",
    status: "running",
    progress: { completed: 0, total: 1 },
    live: { journal: `runs/live/${runId}-m1.jsonl`, model: "m1", task_id: "t1" },
  }),
);
const journal = path.join(dir, "runs", "live", `${runId}-m1.jsonl`);
fs.writeFileSync(
  journal,
  [
    JSON.stringify({ at: 1, kind: "call", tool: "lookup-record", write: false, status: "ok", arguments: '{"id":"rec-1234567890123456"}' }),
    JSON.stringify({ at: 2, kind: "result", tool: "lookup-record", status: "ok", content: "{}" }),
    JSON.stringify({ at: 3, kind: "call", tool: "update-record", write: true, status: "ok", arguments: '{"id":"rec-1234567890123456"}' }),
  ].join("\n") + "\n",
);

const get = (qs) => GET(new Request(`http://localhost/api/runs/live?${qs}`));

describe("GET /api/runs/live", () => {
  it("400s without params and on an invalid run id", async () => {
    assert.equal((await get("slug=data--livebench")).status, 400);
    assert.equal((await get("slug=data--livebench&run=../escape")).status, 400);
  });

  it("404s on unknown slug or run", async () => {
    assert.equal((await get("slug=data--nope&run=run-x")).status, 404);
    assert.equal((await get("slug=data--livebench&run=run-doesnotexist1")).status, 404);
  });

  it("serves journal lines with a since offset and a live accumulation from the shared scorer", async () => {
    const res = await get(`slug=data--livebench&run=${runId}&task=t1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "running");
    assert.equal(body.lines.length, 3);
    assert.equal(body.next, 3);
    // The live accumulation flips the required effect met at the matching call.
    assert.equal(body.accumulation.required.length, 1);
    assert.notEqual(body.accumulation.required[0].met_at, null);
    assert.equal(body.accumulation.verdict.task_completed_correctly, true);

    const offset = await (await get(`slug=data--livebench&run=${runId}&task=t1&since=2`)).json();
    assert.equal(offset.lines.length, 1);
    assert.equal(offset.lines[0].tool, "update-record");
    assert.equal(offset.next, 3);

    // New line lands → next poll picks it up from the offset.
    fs.appendFileSync(journal, JSON.stringify({ at: 4, kind: "result", tool: "update-record", status: "ok", content: "{}" }) + "\n");
    const grown = await (await get(`slug=data--livebench&run=${runId}&task=t1&since=3`)).json();
    assert.equal(grown.lines.length, 1);
    assert.equal(grown.next, 4);
  });

  it("rejected calls in the journal do not satisfy the contract", async () => {
    const run2 = "run-live0000000002";
    fs.writeFileSync(
      path.join(dir, "runs", "queue", `${run2}.json`),
      JSON.stringify({
        schema_version: "understudy.run_request.v1",
        run_id: run2,
        benchmark_id: "live-bench",
        models: ["m1"],
        split: "all",
        tasks: ["t1"],
        rollouts_per_task: 1,
        created_at: "2026-07-22T00:00:00Z",
        status: "running",
        progress: { completed: 0, total: 1 },
        live: { journal: `runs/live/${run2}-m1.jsonl`, model: "m1", task_id: "t1" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "runs", "live", `${run2}-m1.jsonl`),
      JSON.stringify({ at: 1, kind: "call", tool: "update-record", write: false, status: "error", arguments: '{"id":"rec-1234567890123456"}' }) + "\n",
    );
    const body = await (await get(`slug=data--livebench&run=${run2}&task=t1`)).json();
    assert.equal(body.accumulation.required[0].met_at, null, "validation-rejected call never satisfies");
  });
});
