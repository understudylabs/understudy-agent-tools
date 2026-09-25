import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkloads, resolveWorkload } from "../dist/internal/workloads.js";

test("workload discovery follows every page and rejects ambiguous or inconsistent inventories", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.UNDERSTUDY_API_KEY;
  const previousGateway = process.env.UNDERSTUDY_GATEWAY_URL;
  const previousHome = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "understudy-workload-inventory-"));
  const project = { projectId: "proj_synthetic", projectSlug: null, project: null,
    auth: { orgId: "org_synthetic" } };
  let pages;
  let calls;
  const setup = (responses) => {
    pages = responses;
    calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(pages.shift()), { headers: { "content-type": "application/json" } });
    };
  };
  const first = { id: "wl_first", name: "first", project_id: project.projectId };
  const target = { id: "wl_target", name: "target", project_id: project.projectId };
  try {
    process.env.HOME = root;
    process.env.UNDERSTUDY_API_KEY = "sk_synthetic_inventory";
    process.env.UNDERSTUDY_GATEWAY_URL = "https://synthetic.example.test";
    setup([{ workloads: [first], cursor: "next/+" }, { workloads: [target], cursor: null }]);
    assert.equal((await resolveWorkload(project, "target")).id, target.id);
    assert.match(calls[1], /cursor=next%2F%2B$/);
    setup([{ workloads: [first], cursor: "loop" }, { workloads: [], cursor: "loop" }]);
    await assert.rejects(() => listWorkloads(project), /repeated cursor/);
    setup([{ workloads: [first], cursor: "next" }, { workloads: [first] }]);
    await assert.rejects(() => listWorkloads(project), /repeated an ID/);
    setup([{ workloads: [{ ...first, project_id: "different_project" }] }]);
    await assert.rejects(() => listWorkloads(project), /different project/);
    setup([{ workloads: [target, { ...first, name: "target" }] }]);
    await assert.rejects(() => resolveWorkload(project, "target"), /ambiguous/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [["UNDERSTUDY_API_KEY", previousKey], ["UNDERSTUDY_GATEWAY_URL", previousGateway], ["HOME", previousHome]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
