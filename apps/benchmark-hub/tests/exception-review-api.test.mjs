import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { POST as postAuto } from "./.build/app/api/reviews/auto/route.js";
import { POST as postFeedback } from "./.build/app/api/feedback/route.js";
import { POST as postReview } from "./.build/app/api/reviews/route.js";

const feedbackSchema = JSON.parse(
  fs.readFileSync(path.resolve("../../schemas/understudy.task_feedback.v1.schema.json"), "utf8"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-exception-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A hand-written foundry proposal: one clean high-confidence task (auto),
// one low-confidence task (exception), one self-check failure (exception).
function task(id, overrides = {}) {
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
const tasks = [
  task("t-clean"),
  task("t-low", { machine_confidence: "low" }),
  task("t-selfcheck", { self_check: { ok: false, failures: [{ check: "empty_contract", detail: "d" }] } }),
];
const outDir = path.join(tmp, "prop");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({
    schema_version: "understudy.trace_foundry.v1",
    freshness: { max_age_days: 30, cutoff_utc: "2026-07-01T00:00:00Z", newest_capture_utc: "2026-07-20T00:00:00Z" },
    counts: { source_files: 1, captures: 1, tasks: tasks.length, edges: 0, stale_filtered: 0, invalid_timestamp_filtered: 0 },
  }),
);
fs.writeFileSync(path.join(outDir, "tasks.jsonl"), tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
fs.writeFileSync(
  path.join(outDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark_proposal.v1",
    benchmark_id: "prop-bench",
    tasks: tasks.map((t) => ({ task_id: t.task_id })),
  }),
);

function post(handler, url, body) {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/reviews/auto", () => {
  it("rejects a non-JSON body with 400 and an unknown slug with 404", async () => {
    assert.equal((await post(postAuto, "http://localhost/api/reviews/auto", "not json")).status, 400);
    assert.equal((await post(postAuto, "http://localhost/api/reviews/auto", { slug: "data--nope" })).status, 404);
  });

  it("applies auto-accepts for clean tasks only, stamped source:'auto'", async () => {
    const res = await post(postAuto, "http://localhost/api/reviews/auto", { slug: "data--prop" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.applied, ["t-clean"]);
    assert.equal(body.exceptions, 2);

    const lines = fs.readFileSync(path.join(outDir, "reviews.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].task_id, "t-clean");
    assert.equal(lines[0].decision, "accept");
    assert.equal(lines[0].source, "auto");
  });

  it("second apply is a no-op; a human review-bar POST supersedes the auto line", async () => {
    const again = await post(postAuto, "http://localhost/api/reviews/auto", { slug: "data--prop" });
    assert.deepEqual((await again.json()).applied, []);

    const override = await post(postReview, "http://localhost/api/reviews", {
      slug: "data--prop",
      task_id: "t-clean",
      decision: "restrict",
      note: "narrow the contract",
    });
    assert.equal(override.status, 200);
    const { getEntry } = await import("./.build/lib/data-core.js");
    const latest = getEntry("data--prop").latestReviewByTask["t-clean"];
    assert.equal(latest.decision, "restrict");
    assert.equal(latest.source, undefined);
  });
});

describe("POST /api/feedback", () => {
  it("rejects bad input: non-JSON 400, unknown slug 404, empty feedback 400, unknown task 404", async () => {
    assert.equal((await post(postFeedback, "http://localhost/api/feedback", "not json")).status, 400);
    assert.equal((await post(postFeedback, "http://localhost/api/feedback", { slug: "data--nope", task_id: "t-low", feedback: "x" })).status, 404);
    assert.equal((await post(postFeedback, "http://localhost/api/feedback", { slug: "data--prop", task_id: "t-low", feedback: "   " })).status, 400);
    assert.equal((await post(postFeedback, "http://localhost/api/feedback", { slug: "data--prop", task_id: "t-999", feedback: "x" })).status, 404);
  });

  it("appends a schema-valid understudy.task_feedback.v1 line and returns the agent handoff", async () => {
    const res = await post(postFeedback, "http://localhost/api/feedback", {
      slug: "data--prop",
      task_id: "t-low",
      feedback: "the boundary is wrong — the second capture belongs to a different task",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.feedback.schema_version, "understudy.task_feedback.v1");
    for (const key of feedbackSchema.required) assert.notEqual(body.feedback[key], undefined, `missing ${key}`);
    assert.equal(body.feedback.status, "open");
    assert.ok(body.handoff.includes("understudy traces regenerate-env --benchmark"));
    assert.ok(body.handoff.includes("t-low"));
    assert.ok(body.handoff.includes("the boundary is wrong"));

    const lines = fs.readFileSync(path.join(outDir, "feedback.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].task_id, "t-low");
    // The proposal-stamped benchmark.json's benchmark_id, NOT the dir basename ("prop").
    assert.equal(lines[0].benchmark_id, "prop-bench");
  });
});
