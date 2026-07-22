import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Real in-tree foundry builds the fixture, like proposed.test.mjs — the
// route is exercised against genuine understudy.trace_foundry.v1 output.
import { compileTraceFoundry } from "../../../dist/trace-foundry.js";
import { GET } from "./.build/app/api/trace-viewer/route.js";
import { taskTraceGroups, viewerCacheDir } from "./.build/lib/trace-viewer-core.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-hub-tviewer-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
delete process.env.UNDERSTUDY_CLI_DIST;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const capture = (id, ts, messages, response, extra = {}) => ({
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
  ...extra,
});

const source = path.join(tmp, "captures-src");
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(
  path.join(source, "captures.jsonl"),
  [
    capture("round-1", "2026-07-20T12:00:00Z", [{ role: "user", content: "Set record 7 active" }], {
      content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7 } }],
      stop_reason: "tool_use",
    }),
    capture(
      "round-2",
      "2026-07-20T12:00:01Z",
      [
        { role: "user", content: "Set record 7 active" },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "update-record", input: { id: 7 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' }] },
      ],
      { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" },
    ),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
const outDir = path.join(tmp, "tviewer-demo");
compileTraceFoundry(source, outDir, 36500, new Date("2026-07-21T12:00:00Z"));

const slug = "data--tviewer-demo";
const taskId = JSON.parse(fs.readFileSync(path.join(outDir, "tasks.jsonl"), "utf8").split("\n")[0]).task_id;

function get(params) {
  const qs = new URLSearchParams(params).toString();
  return GET(new Request(`http://localhost/api/trace-viewer?${qs}`));
}

describe("trace-viewer API guards", () => {
  it("requires slug and task", async () => {
    assert.equal((await get({ slug })).status, 400);
    assert.equal((await get({ task: taskId })).status, 400);
  });

  it("404s an unknown slug and a captureless task", async () => {
    assert.equal((await get({ slug: "data--nope", task: taskId })).status, 404);
    assert.equal((await get({ slug, task: "no-such-task" })).status, 404);
  });

  it("rejects a non-allowlisted file name", async () => {
    const res = await get({ slug, task: taskId, file: "../../../etc/passwd" });
    assert.equal(res.status, 400);
  });

  it("404s a trace id that is not one of the task's traces", async () => {
    const res = await get({ slug, task: taskId, file: "index.html", trace: "trace-that-does-not-exist" });
    assert.equal(res.status, 404);
  });
});

describe("trace-viewer list mode", () => {
  it("lists one timeline (no trace context in these captures)", async () => {
    const res = await get({ slug, task: taskId });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.task_id, taskId);
    assert.equal(body.traces.length, 1);
    assert.equal(body.traces[0].trace_id, null);
    assert.equal(body.traces[0].captures, 2);
    assert.match(body.traces[0].href, /file=index\.html$/);
  });
});

describe("trace-viewer build + serve", () => {
  it("builds into .trace-viewer-cache and serves index.html + trace-data.js", async () => {
    const html = await get({ slug, task: taskId, file: "index.html" });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const page = await html.text();
    // Theme-contract template, with the data script rewritten to this route.
    assert.match(page, /--viz-series-6/);
    assert.match(page, /\/api\/trace-viewer\?slug=/);
    assert.doesNotMatch(page, /src="\.\/trace-data\.js"/);

    const data = await get({ slug, task: taskId, file: "trace-data.js" });
    assert.equal(data.status, 200);
    assert.match(data.headers.get("content-type"), /javascript/);
    const js = await data.text();
    assert.match(js, /window\.TRACE_CAPTURES/);
    assert.match(js, /round-1/);

    const cacheDir = viewerCacheDir(outDir, taskId, null);
    assert.ok(fs.existsSync(path.join(cacheDir, "index.html")));
    assert.ok(fs.existsSync(path.join(cacheDir, "manifest.json")));
    // Owner-only artifacts, like every foundry output.
    const mode = fs.statSync(path.join(cacheDir, "trace-data.js")).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("cache-hits: a second request does not rewrite the artifacts", async () => {
    const cacheDir = viewerCacheDir(outDir, taskId, null);
    const before = fs.statSync(path.join(cacheDir, "trace-data.js")).mtimeMs;
    const res = await get({ slug, task: taskId, file: "index.html" });
    assert.equal(res.status, 200);
    const afterMs = fs.statSync(path.join(cacheDir, "trace-data.js")).mtimeMs;
    assert.equal(afterMs, before);
  });

  it("injects data-theme from the hub theme cookie", async () => {
    const res = await GET(
      new Request(`http://localhost/api/trace-viewer?slug=${slug}&task=${taskId}&file=index.html`, {
        headers: { cookie: "theme=light" },
      }),
    );
    assert.match(await res.text(), /<html lang="en" data-theme="light">/);
  });

  it("groups multi-trace tasks one timeline per trace id", () => {
    // Unit-level: the grouper reads trace ids off the capture bodies.
    const dir = path.join(tmp, "multi");
    fs.mkdirSync(path.join(dir, "viewer", "data", "captures"), { recursive: true });
    // Reuse the fixture's derivation by writing tasks.jsonl + bodies directly.
    const refs = [
      { capture_id: "a", sha256: "s1" },
      { capture_id: "b", sha256: "s2" },
    ];
    fs.writeFileSync(
      path.join(dir, "tasks.jsonl"),
      JSON.stringify({
        schema_version: "understudy.benchmark_task.v1",
        task_id: "t-multi",
        source: { captures: refs },
      }) + "\n",
    );
    refs.forEach((ref, i) => {
      const fileId = createHash("sha256")
        .update(JSON.stringify({ capture_id: ref.capture_id, source_sha256: ref.sha256 }))
        .digest("hex")
        .slice(0, 40);
      fs.writeFileSync(
        path.join(dir, "viewer", "data", "captures", `${fileId}.json`),
        JSON.stringify({ capture_id: ref.capture_id, captured_at: "2026-07-20T12:00:00Z", trace_id: `trace-${i}` }),
      );
    });
    const groups = taskTraceGroups(dir, "t-multi");
    assert.deepEqual(
      groups.map((g) => g.traceId),
      ["trace-0", "trace-1"],
    );
    assert.equal(groups[0].captureFiles.length, 1);
  });

  it("returns 503 with the build-the-CLI state when the dist is missing", async () => {
    process.env.UNDERSTUDY_CLI_DIST = path.join(tmp, "no-dist", "trace-viewer.js");
    try {
      const res = await get({ slug, task: taskId, file: "index.html" });
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /build the CLI first/);
    } finally {
      delete process.env.UNDERSTUDY_CLI_DIST;
    }
  });
});
