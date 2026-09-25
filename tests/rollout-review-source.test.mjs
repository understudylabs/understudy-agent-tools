import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { acquireRolloutSources, loadReviewSpec, readRolloutSources } from "../dist/rollout-review-source.js";

// All scopes, identities, contents, and timestamps are synthetic.
function spec() {
  return {
    schema_version: "understudy.rollout-review-spec.v1", org_id: "org_synthetic", project_id: "proj_synthetic",
    before: { workload_id: "usp_before", workload_name: "synthetic-before", from: "2024-04-01T08:00:00Z", to: "2024-04-02T09:00:00Z" },
    after: { workload_id: "usp_after", workload_name: "synthetic-after", from: "2024-04-04T10:00:00Z", to: "2024-04-04T11:00:00Z" },
    selectors: { taskId: "/customer_request_body/metadata/task_id", userId: "/customer_request_body/metadata/user_id", environment: "/tags/environment" },
  };
}
function temp(t) { const dir = mkdtempSync(join(realpathSync(tmpdir()), "rollout-source-test-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function save(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function isolatedCredentials(t) {
  const directory = temp(t); const original = os.homedir;
  os.homedir = () => directory; syncBuiltinESMExports();
  t.after(() => { os.homedir = original; syncBuiltinESMExports(); });
}
function hooks(selected = spec(), changes = {}) {
  const state = { searches: [], batches: [], listings: 0, references: new Map() };
  const dependencies = {
    listWorkloads: async () => { state.listings++; return [selected.before, selected.after].map(side => ({ id: side.workload_id, name: side.workload_name, project_id: selected.project_id })); },
    search: async input => {
      state.searches.push(input);
      const id = `req_${state.searches.length}`;
      const row = { request_id: id, captured_at: input.from };
      state.references.set(id, { ...row, workload_id: input.workloadId });
      return { window: { from: input.from, to: input.to }, index_window: { from: input.from, to: new Date(Date.parse(input.from) + 86_400_000).toISOString() }, ingestion_cutoff: "2024-04-06T00:00:00.000Z", captures: [row], scanned_count: 1, pages: 1 };
    },
    exportBatch: async input => {
      state.batches.push(input);
      for (const id of input.requestIds) {
        const ref = state.references.get(id);
        save(join(input.outputDirectory, `${encodeURIComponent(id)}.payload.json`), {
          schema_version: 4, request_id: id, ts: ref?.captured_at ?? "2024-04-01T08:00:00Z",
          workos_org_id: input.orgId, project_id: input.projectId, workload_id: input.workloadId,
          customer_request_body: JSON.stringify({ metadata: { task_id: "task_synthetic", user_id: "user_synthetic" } }),
          response_body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Synthetic result" } }] }),
        });
      }
      return { ok: true, input_count: input.requestIds.length, unique_count: input.requestIds.length, written: input.requestIds.length, skipped: 0, failed: 0, failed_request_ids: [], output_directory: input.outputDirectory, failure_manifest: join(input.outputDirectory, "failed-request-ids.txt"), output_suffix: ".payload.json", include_payload: true, warning: null };
    },
    ...changes,
  };
  return { state, dependencies };
}

test("spec requires exact UTC nonoverlapping past windows, pointer selectors, and explicit duration basis", t => {
  const path = join(temp(t), "spec.json");
  save(path, spec());
  assert.equal(loadReviewSpec(path).before.from, "2024-04-01T08:00:00.000Z");
  for (const mutate of [
    value => { value.before.from = "2024-02-30T08:00:00Z"; },
    value => { value.before.from = "2024-04-01T08:00:00+00:00"; },
    value => { value.before.from = "2024-04-01T08:00:00.0001Z"; },
    value => { value.after.from = value.before.from; },
    value => { value.after.to = "2999-01-01T00:00:00Z"; },
    value => { value.selectors.taskId = "metadata.task_id"; },
    value => { value.selectors.userId = "/bad~2pointer"; },
    value => { value.selectors.durationMs = "/latency_ms"; },
    value => { value.durationBasis = ""; },
    value => { value.before.workload_name = ""; },
    value => { value.extra = true; },
  ]) { const value = spec(); mutate(value); save(path, value); assert.throws(() => loadReviewSpec(path), /Invalid rollout review spec/); }
  const timed = spec(); timed.selectors.durationMs = "/latency_ms"; timed.durationBasis = "Captured model response duration, not end-to-end task duration";
  save(path, timed); assert.equal(loadReviewSpec(path).durationBasis, timed.durationBasis);
});

test("acquisition partitions exact windows, binds every request and verifies offline resume", async t => {
  const root = temp(t); const { state, dependencies } = hooks();
  const output = await acquireRolloutSources(spec(), root, dependencies);
  assert.equal(state.searches.length, 3);
  assert.deepEqual(state.searches.map(({ from, to }) => [from, to]), [
    ["2024-04-01T08:00:00.000Z", "2024-04-02T08:00:00.000Z"],
    ["2024-04-02T08:00:00.000Z", "2024-04-02T09:00:00.000Z"],
    ["2024-04-04T10:00:00.000Z", "2024-04-04T11:00:00.000Z"],
  ]);
  assert.deepEqual(state.batches.map(batch => [batch.requestIds.length, batch.includePayload, batch.resume]), [[2, true, false], [1, true, false]]);
  assert.equal(output.before.captures.length, 2); assert.equal(output.after.captures.length, 1);
  assert.equal(output.before.captures[0].source.request_started_at, "2024-04-01T08:00:00.000Z");
  const receipt = json(join(root, "sources", "receipt.json"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.inventory_sha256, digest(readFileSync(join(root, "sources", "inventory.json"))));
  assert.deepEqual(receipt.captures.before.map(row => row.request_id), ["req_1", "req_2"]);
  assert.equal(statSync(join(root, receipt.captures.before[0].path)).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "sources")).mode & 0o777, 0o700);
  assert.deepEqual(readRolloutSources(spec(), root), output);
  const noNetwork = async () => { throw new Error("Network must not run during completed resume"); };
  assert.deepEqual(await acquireRolloutSources(spec(), root, { search: noNetwork, exportBatch: noNetwork, listWorkloads: noNetwork }), output);
});

test("zero matches are complete capture availability with empty denominators, no payload request", async t => {
  const root = temp(t); const setup = hooks();
  const search = setup.dependencies.search;
  setup.dependencies.search = async input => ({ ...await search(input), captures: [], scanned_count: 0 });
  const output = await acquireRolloutSources(spec(), root, setup.dependencies);
  assert.equal(output.before.captures.length, 0); assert.equal(output.after.captures.length, 0);
  assert.equal(setup.state.batches.length, 0); assert.equal(json(join(root, "sources", "receipt.json")).complete, true);
});

test("missing or skipped payloads are incomplete and cannot build", async t => {
  for (const override of [{ ok: false, failed: 1 }, { skipped: 1, written: 1 }, { include_payload: false }]) {
    const root = temp(t); const setup = hooks(); const exportBatch = setup.dependencies.exportBatch;
    setup.dependencies.exportBatch = async input => ({ ...await exportBatch(input), ...override });
    await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /incomplete/);
    assert.equal(json(join(root, "sources", "receipt.json")).complete, false);
    assert.throws(() => readRolloutSources(spec(), root), /incomplete/);
  }
});

test("resume uses frozen inventory and verified receipts, fetching only missing IDs", async t => {
  const root = temp(t); const setup = hooks(); const exportBatch = setup.dependencies.exportBatch;
  setup.dependencies.exportBatch = async input => {
    if (input.workloadId === "usp_after") throw new Error("Synthetic interrupted transfer");
    return exportBatch(input);
  };
  await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /interrupted/);
  const beforeHash = digest(readFileSync(join(root, "sources", "inventory.json")));
  setup.dependencies.search = async () => { throw new Error("Frozen inventory must not refresh"); };
  const resumedIds = [];
  setup.dependencies.exportBatch = async input => { resumedIds.push(...input.requestIds); return exportBatch(input); };
  const output = await acquireRolloutSources(spec(), root, setup.dependencies);
  assert.deepEqual(resumedIds, ["req_3"]); assert.equal(output.before.captures.length, 2);
  assert.equal(beforeHash, digest(readFileSync(join(root, "sources", "inventory.json"))));
});

test("partial inventory resumes after the last completed partition", async t => {
  const root = temp(t); const setup = hooks(); const search = setup.dependencies.search;
  setup.dependencies.search = async input => {
    if (setup.state.searches.length === 1) throw new Error("Synthetic inventory interruption");
    return search(input);
  };
  await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /inventory interruption/);
  assert.equal(json(join(root, "sources", "inventory.json")).partitions.length, 1);
  setup.dependencies.search = search;
  await acquireRolloutSources(spec(), root, setup.dependencies);
  assert.equal(setup.state.searches.length, 3);
});

test("identity mismatches fail before a complete receipt, including conflicting legacy workload aliases", async t => {
  for (const override of [{ request_id: "wrong" }, { workos_org_id: "org_other" }, { project_id: "proj_other" }, { workload_id: "usp_other" }, { placement_id: "usp_other" }]) {
    const root = temp(t); const setup = hooks(); const exportBatch = setup.dependencies.exportBatch;
    setup.dependencies.exportBatch = async input => {
      const summary = await exportBatch(input);
      const path = join(input.outputDirectory, `${input.requestIds[0]}.payload.json`);
      save(path, { ...json(path), ...override }); return summary;
    };
    await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /identity/);
    assert.equal(json(join(root, "sources", "receipt.json")).complete, false);
  }
});

test("local reads reject changed payload bytes, inventory commitments, member sets, paths and specs", async t => {
  for (const kind of ["bytes", "inventory", "member", "path", "spec"]) {
    const root = temp(t); await acquireRolloutSources(spec(), root, hooks().dependencies);
    const path = join(root, "sources", "receipt.json"); const receipt = json(path);
    if (kind === "bytes") writeFileSync(join(root, receipt.captures.before[0].path), "{}\n");
    if (kind === "inventory") { const target = join(root, "sources", "inventory.json"); writeFileSync(target, `${readFileSync(target, "utf8")} `); }
    if (kind === "member") { receipt.captures.before.pop(); save(path, receipt); }
    if (kind === "path") { receipt.captures.before[0].path = "../outside.json"; save(path, receipt); }
    const value = spec(); if (kind === "spec") value.selectors.userId = "/different";
    assert.throws(() => readRolloutSources(value, root), /changed|hash|cover|path|spec/);
  }
});

test("out-of-window and repeated inventory IDs are rejected", async t => {
  for (const kind of ["outside", "repeated", "scope"]) {
    const root = temp(t); const setup = hooks(); const search = setup.dependencies.search;
    setup.dependencies.search = async input => {
      const result = await search(input);
      if (kind === "outside") result.captures[0].captured_at = input.to;
      if (kind === "repeated") result.captures[0].request_id = "same_request";
      if (kind === "scope") result.window.from = "2024-04-01T00:00:00.000Z";
      return result;
    };
    await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /Inventory/);
    assert.equal(setup.state.batches.length, 0);
  }
});

test("workload label mismatch fails before inventory or payload reads", async t => {
  const root = temp(t); const setup = hooks();
  setup.dependencies.listWorkloads = async () => [{ id: "usp_before", name: "wrong-label" }];
  await assert.rejects(acquireRolloutSources(spec(), root, setup.dependencies), /Selected workload/);
  assert.equal(setup.state.searches.length, 0);
});

test("private source paths refuse symlinks at output and artifact boundaries", async t => {
  const root = temp(t); const outside = temp(t); const linked = join(root, "linked");
  symlinkSync(outside, linked);
  await assert.rejects(acquireRolloutSources(spec(), linked, hooks().dependencies), /symlink/);
  await acquireRolloutSources(spec(), root, hooks().dependencies);
  const receipt = json(join(root, "sources", "receipt.json")); const path = join(root, receipt.captures.before[0].path);
  const target = join(outside, "copy.json"); writeFileSync(target, readFileSync(path)); rmSync(path); symlinkSync(target, path);
  assert.throws(() => readRolloutSources(spec(), root), /symlink/);
});

test("real customer workload discovery follows cursors and only performs GET", async t => {
  isolatedCredentials(t);
  const oldFetch = globalThis.fetch; const oldKey = process.env.UNDERSTUDY_API_KEY;
  process.env.UNDERSTUDY_API_KEY = "synthetic-test-key";
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.UNDERSTUDY_API_KEY; else process.env.UNDERSTUDY_API_KEY = oldKey; });
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(new URL(url)); assert.equal(init.method, "GET");
    return new Response(JSON.stringify(urls.length === 1
      ? { workloads: [{ id: "usp_before", name: "synthetic-before", project_id: "proj_synthetic" }], cursor: "next_synthetic" }
      : { workloads: [{ id: "usp_after", name: "synthetic-after", project_id: "proj_synthetic" }], cursor: null }), { status: 200 });
  };
  const setup = hooks(); delete setup.dependencies.listWorkloads;
  await acquireRolloutSources(spec(), temp(t), setup.dependencies);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, "/admin/v1/orgs/org_synthetic/projects/proj_synthetic/workloads");
  assert.equal(urls[1].searchParams.get("cursor"), "next_synthetic");
});

test("default acquisition uses only public metadata POST and scoped capture GET, unwrapping full capture envelopes", async t => {
  isolatedCredentials(t);
  const oldFetch = globalThis.fetch; const oldKey = process.env.UNDERSTUDY_API_KEY;
  process.env.UNDERSTUDY_API_KEY = "synthetic-test-key";
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.UNDERSTUDY_API_KEY; else process.env.UNDERSTUDY_API_KEY = oldKey; });
  const selected = spec(); const calls = []; const records = new Map();
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname; calls.push([init.method, path]);
    const prefix = "/admin/v1/orgs/org_synthetic/projects/proj_synthetic/workloads";
    let body;
    if (path === prefix && init.method === "GET") body = { workloads: [selected.before, selected.after].map(row => ({ id: row.workload_id, name: row.workload_name })), cursor: null };
    else if (path.endsWith("/captures/export") && init.method === "POST") {
      const requested = JSON.parse(init.body); const workloadId = path.split("/").at(-3);
      const id = `req_http_${records.size}`; const capture = {
        schema_version: 4, request_id: id, workos_org_id: selected.org_id, project_id: selected.project_id, workload_id: workloadId,
        ts: requested.from, customer_request_body: '{"metadata":{"task_id":"task_synthetic","user_id":"user_synthetic"}}', response_body: '{}',
      }; records.set(id, capture);
      body = {
        canonical_scope: { schema_version: "understudy.export-scope.v1", selector: "workload-window", org_id: selected.org_id, project_id: selected.project_id, workload_id: workloadId, from: requested.from, to: requested.to, ingestion_cutoff: "2024-04-06T00:00:00.000Z" },
        captures: [{ request_id: id, captured_at: requested.from, capture_key: `${selected.org_id}/${selected.project_id}/synthetic_key/2024/04/01/${id}.jsonl`, url: `https://example.r2.cloudflarestorage.com/${id}.jsonl?synthetic=true` }], next_cursor: null,
      };
    } else if (path.includes("/captures/req_http_") && init.method === "GET") {
      const capture = records.get(path.split("/").at(-1)); assert.ok(capture); assert.ok(path.includes(`/workloads/${capture.workload_id}/`)); body = { capture };
    } else throw new Error("Unexpected endpoint or mutation in rollout acquisition");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const root = temp(t); const output = await acquireRolloutSources(selected, root);
  assert.equal(output.before.captures.length, 2); assert.equal(output.after.captures.length, 1);
  assert.equal(calls.filter(([method]) => method === "POST").length, 3);
  assert.equal(calls.filter(([method]) => method === "GET").length, 4);
  assert.deepEqual(output.before.captures[0].capture.customer_request_body, '{"metadata":{"task_id":"task_synthetic","user_id":"user_synthetic"}}');
  assert.doesNotMatch(readFileSync(join(root, "sources", "inventory.json"), "utf8"), /https:|capture_key|synthetic=true/);
  assert.equal(output.scope.orgId, selected.org_id); assert.equal(output.before.workloadName, selected.before.workload_name);
});

test("standard macOS temporary aliases work while custom symlinks remain forbidden", { skip: process.platform !== "darwin" }, async t => {
  const canonical = temp(t); const alias = canonical.startsWith("/private/var/") ? canonical.replace("/private/var/", "/var/") : canonical.replace("/private/tmp/", "/tmp/");
  const output = await acquireRolloutSources(spec(), alias, hooks().dependencies);
  assert.equal(output.before.captures.length, 2);
  assert.equal(readRolloutSources(spec(), alias).after.captures.length, 1);
});
