import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { POST } from "./.build/app/api/flags/route.js";

const flagSchema = JSON.parse(
  fs.readFileSync(path.resolve("../../schemas/understudy.benchmark_flag.v1.schema.json"), "utf8"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-flags-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
// Demo mode ON so the repo's read-only fixture entries are reachable.
process.env.BENCHMARK_HUB_DEMO = "1";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dir = path.join(tmp, "flaggable");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "flaggable-bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);

function post(body) {
  return POST(
    new Request("http://localhost/api/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

// Same lightweight structural idiom as tests/benchmark-manifest.test.mjs at
// the repo root uses for eval rows.
function validateFlagAgainstSchema(flag) {
  const errors = [];
  for (const key of flagSchema.required ?? []) {
    if (flag[key] === undefined) errors.push(`missing required ${key}`);
  }
  const props = flagSchema.properties ?? {};
  if (props.schema_version?.const && flag.schema_version !== props.schema_version.const) {
    errors.push("wrong schema_version");
  }
  if (props.reason?.enum && !props.reason.enum.includes(flag.reason)) errors.push(`bad reason ${flag.reason}`);
  if (props.status?.enum && !props.status.enum.includes(flag.status)) errors.push(`bad status ${flag.status}`);
  if (flag.task_id !== null && typeof flag.task_id !== "string") errors.push("task_id must be string|null");
  return errors;
}

describe("POST /api/flags", () => {
  it("rejects a non-JSON body with 400", async () => {
    const res = await post("this is not json");
    assert.equal(res.status, 400);
  });

  it("rejects an unknown slug with 404", async () => {
    const res = await post({ slug: "data--no-such-benchmark", reason: "other", task_id: null, note: "" });
    assert.equal(res.status, 404);
  });

  it("rejects read-only fixture entries with 403", async () => {
    const res = await post({ slug: "fixture--benchmark-derived", reason: "other", task_id: null, note: "" });
    assert.equal(res.status, 403);
  });

  it("rejects a bad reason with 400", async () => {
    const res = await post({ slug: "data--flaggable", reason: "because", task_id: null, note: "" });
    assert.equal(res.status, 400);
  });

  it("rejects an unknown task_id with 404", async () => {
    const res = await post({ slug: "data--flaggable", reason: "other", task_id: "t999", note: "" });
    assert.equal(res.status, 404);
  });

  it("rejects an oversized note with 413", async () => {
    const res = await post({ slug: "data--flaggable", reason: "other", task_id: null, note: "x".repeat(2001) });
    assert.equal(res.status, 413);
  });

  it("happy path appends a schema-valid flag line to flags.jsonl", async () => {
    const res = await post({ slug: "data--flaggable", reason: "bad-gold", task_id: "t1", note: "gold is wrong" });
    assert.equal(res.status, 200);
    const { ok, flag } = await res.json();
    assert.equal(ok, true);
    assert.deepEqual(validateFlagAgainstSchema(flag), []);
    assert.equal(flag.benchmark_id, "flaggable-bench");
    assert.equal(flag.task_id, "t1");
    assert.equal(flag.status, "open");

    const lines = fs.readFileSync(path.join(dir, "flags.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(validateFlagAgainstSchema(JSON.parse(lines[0])), []);
  });
});
