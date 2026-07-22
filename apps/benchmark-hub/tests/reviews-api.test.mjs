import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { compileTraceFoundry } from "../../../dist/trace-foundry.js";
import { POST } from "./.build/app/api/reviews/route.js";
import { GET as getCapture } from "./.build/app/api/captures/route.js";

const reviewSchema = JSON.parse(
  fs.readFileSync(path.resolve("../../schemas/understudy.benchmark_review.v1.schema.json"), "utf8"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-reviews-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// One promoted benchmark (reviews must be rejected there)…
const promotedDir = path.join(tmp, "promoted");
fs.mkdirSync(promotedDir, { recursive: true });
fs.writeFileSync(
  path.join(promotedDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "promoted-bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);

// …and one real foundry output (proposed).
const source = path.join(tmp, "captures-src");
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
    response_body: JSON.stringify({ content: [{ type: "tool_use", id: "c1", name: "update-record", input: {} }] }),
    status_code: 200,
  }),
);
const outDir = path.join(tmp, "proposed-demo");
compileTraceFoundry(source, outDir, 36500, new Date("2026-07-21T12:00:00Z"));
const taskId = JSON.parse(fs.readFileSync(path.join(outDir, "tasks.jsonl"), "utf8").trim().split("\n")[0]).task_id;

function post(body) {
  return POST(
    new Request("http://localhost/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

// Same lightweight structural idiom as tests/flags-api.test.mjs.
function validateReviewAgainstSchema(review) {
  const errors = [];
  for (const key of reviewSchema.required ?? []) {
    if (review[key] === undefined) errors.push(`missing required ${key}`);
  }
  const props = reviewSchema.properties ?? {};
  if (props.schema_version?.const && review.schema_version !== props.schema_version.const) {
    errors.push("wrong schema_version");
  }
  if (props.decision?.enum && !props.decision.enum.includes(review.decision)) {
    errors.push(`bad decision ${review.decision}`);
  }
  return errors;
}

describe("POST /api/reviews", () => {
  it("rejects a non-JSON body with 400", async () => {
    assert.equal((await post("not json")).status, 400);
  });

  it("rejects an unknown slug with 404", async () => {
    assert.equal((await post({ slug: "data--nope", task_id: taskId, decision: "accept" })).status, 404);
  });

  it("rejects a promoted benchmark with 400 (reviews are proposed-stage only)", async () => {
    const res = await post({ slug: "data--promoted", task_id: "t1", decision: "accept" });
    assert.equal(res.status, 400);
  });

  it("rejects a bad decision with 400", async () => {
    assert.equal((await post({ slug: "data--proposed-demo", task_id: taskId, decision: "maybe" })).status, 400);
  });

  it("rejects an unknown task_id with 404", async () => {
    assert.equal((await post({ slug: "data--proposed-demo", task_id: "t999", decision: "accept" })).status, 404);
  });

  it("rejects an oversized note with 413", async () => {
    const res = await post({ slug: "data--proposed-demo", task_id: taskId, decision: "accept", note: "x".repeat(2001) });
    assert.equal(res.status, 413);
  });

  it("happy path appends a schema-valid review; newest line supersedes", async () => {
    const first = await post({ slug: "data--proposed-demo", task_id: taskId, decision: "needs_more", note: "hmm" });
    assert.equal(first.status, 200);
    const second = await post({ slug: "data--proposed-demo", task_id: taskId, decision: "accept", note: "ok now" });
    assert.equal(second.status, 200);
    const { ok, review } = await second.json();
    assert.equal(ok, true);
    assert.deepEqual(validateReviewAgainstSchema(review), []);
    assert.equal(review.benchmark_id, "proposed-demo");

    const lines = fs.readFileSync(path.join(outDir, "reviews.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines.at(-1).decision, "accept");

    const { getEntry } = await import("./.build/lib/data-core.js");
    assert.equal(getEntry("data--proposed-demo").latestReviewByTask[taskId].decision, "accept");
  });
});

describe("GET /api/captures", () => {
  const get = (qs) => getCapture(new Request(`http://localhost/api/captures?${qs}`));

  it("requires slug and id", async () => {
    assert.equal((await get("slug=data--proposed-demo")).status, 400);
  });

  it("404s for a non-proposed slug", async () => {
    assert.equal((await get("slug=data--promoted&id=round-1")).status, 404);
  });

  it("404s for an unknown capture id", async () => {
    assert.equal((await get("slug=data--proposed-demo&id=nope")).status, 404);
  });

  it("serves the normalized capture body lazily from disk", async () => {
    const res = await get("slug=data--proposed-demo&id=round-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.capture_id, "round-1");
    assert.equal(body.schema_version, "understudy.normalized_capture.v1");
    assert.ok(body.raw);
  });

  it("404s when the capture body file is missing on disk", async () => {
    const capturesDir = path.join(outDir, "viewer", "data", "captures");
    const backup = path.join(tmp, "captures-backup");
    fs.renameSync(capturesDir, backup);
    try {
      assert.equal((await get("slug=data--proposed-demo&id=round-1")).status, 404);
    } finally {
      fs.renameSync(backup, capturesDir);
    }
  });
});
