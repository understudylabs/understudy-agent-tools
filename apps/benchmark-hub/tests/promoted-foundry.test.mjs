import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Built by the real in-tree foundry + promotion verb, not a hand-rolled fixture.
import { compileTraceFoundry, promoteTraceBenchmark } from "../../../dist/trace-foundry.js";
import { getEntry, loadHub } from "./.build/lib/data-core.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-promoted-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
    capture("a-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Create automation alpha for pipesim" }], {
      content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7, status: "active" } }],
      stop_reason: "tool_use",
    }),
    capture("b-1", "2026-07-20T13:00:00Z", [{ role: "user", content: "Archive report beta now" }], {
      content: [{ type: "tool_use", id: "c2", name: "archive-report", input: { report: "beta" } }],
      stop_reason: "tool_use",
    }),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
const dir = path.join(tmp, "promoted-demo");
compileTraceFoundry(source, dir, 36500, new Date("2026-07-21T12:00:00Z"));
const tasks = fs.readFileSync(path.join(dir, "tasks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("proposal stamp recognition", () => {
  it("still surfaces an unpromoted foundry dir (proposal-stamped benchmark.json) as proposed", () => {
    const proposal = JSON.parse(fs.readFileSync(path.join(dir, "benchmark.json"), "utf8"));
    assert.equal(proposal.schema_version, "understudy.benchmark_proposal.v1");
    const entry = getEntry("data--promoted-demo");
    assert.equal(entry.kind, "proposed");
    assert.deepEqual(entry.crossCheckErrors, [], "task ids cross-check against the renamed proposal stamp");
  });
});

describe("promoted foundry dir", () => {
  it("surfaces as PROMOTED with its review history once promote has run, despite the foundry manifest.json", () => {
    const review = (task_id, decision, created_at) => ({
      schema_version: "understudy.benchmark_review.v1",
      benchmark_id: "promoted-demo",
      task_id,
      decision,
      note: "",
      created_at,
    });
    fs.writeFileSync(
      path.join(dir, "reviews.jsonl"),
      [review(tasks[0].task_id, "accept", "2026-07-21T13:00:00Z"), review(tasks[1].task_id, "reject", "2026-07-21T13:01:00Z")]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    promoteTraceBenchmark(dir, { now: new Date("2026-07-21T14:00:00Z"), promotedBy: "hub-test" });

    assert.ok(fs.existsSync(path.join(dir, "manifest.json")), "trace_foundry manifest.json still present");
    const entry = getEntry("data--promoted-demo");
    assert.equal(entry.kind, "ok", "promoted dir loads as a real benchmark, not proposed");
    assert.equal(entry.manifest.schema_version, "understudy.benchmark.v1");
    assert.equal(entry.manifest.tasks.length, 1, "rejected task excluded");
    assert.equal(entry.promotionRecord.schema_version, "understudy.promotion_record.v1");
    assert.equal(entry.promotionRecord.promoted_by, "hub-test");
    assert.equal(entry.reviews.length, 2, "review history surfaces with the promoted entry");
    const hub = loadHub();
    assert.ok(hub.some((e) => e.slug === "data--promoted-demo" && e.kind === "ok"));
  });
});
