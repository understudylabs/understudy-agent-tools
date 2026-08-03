import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Provider-free contract test for the GEPA env sidecar. It exercises the REAL
 * HTTP request/response protocol against a spawned sidecar over the in-process
 * offline env — no student model, no fakes. Covers /pool, /reset, valid-action
 * and malformed-action behavior on /step, and exit/termination semantics
 * (step-budget done + post-termination rejection) plus /score.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "..", "experiments", "domain-identification-repair", "gepa", "env-sidecar.mjs");
const PORT = 8791; // dedicated test port, away from the default 8787
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}
async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  proc = spawn(process.execPath, [SIDECAR], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await get("/pool?split=dev");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("sidecar did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  if (proc) proc.kill("SIGTERM");
});

describe("env-sidecar HTTP contract (real offline env)", () => {
  it("GET /pool returns the fixture, a 64-hex split hash, and 8 dev tasks in known bands", async () => {
    const { status, body } = await get("/pool?split=dev");
    assert.equal(status, 200);
    assert.equal(body.fixture, "domain-identification-offline-v1");
    assert.match(body.fixture_sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.split, "dev");
    assert.match(body.split_sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.tasks.length, 8);
    const bands = new Set(["direct-match", "near-match", "parent-join", "abstain"]);
    for (const t of body.tasks) {
      assert.ok(typeof t.task_id === "string" && t.task_id.length > 0);
      assert.ok(typeof t.prompt === "string" && t.prompt.length > 0);
      assert.ok(bands.has(t.band), `band ${t.band}`);
    }
  });

  it("POST /reset opens a session and 404s an unknown task", async () => {
    const pool = (await get("/pool?split=dev")).body;
    const ok = await post("/reset", { taskId: pool.tasks[0].task_id });
    assert.equal(ok.status, 200);
    assert.ok(typeof ok.body.session === "string");
    const missing = await post("/reset", { taskId: "domain-id-does-not-exist-99" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "unknown task");
  });

  it("valid action returns an observation and advances the step counter", async () => {
    const pool = (await get("/pool?split=dev")).body;
    const { session } = (await post("/reset", { taskId: pool.tasks[0].task_id })).body;
    const step = await post("/step", { session, action: { name: "api_search", arguments: { query: "crm contacts" } } });
    assert.equal(step.status, 200);
    assert.equal(typeof step.body.observation, "string");
    assert.equal(typeof step.body.done, "boolean");
    assert.equal(step.body.step, 1);
  });

  it("malformed actions: unknown tool is surfaced in-band; a null action is a 400, neither crashes the sidecar", async () => {
    const pool = (await get("/pool?split=dev")).body;
    const { session } = (await post("/reset", { taskId: pool.tasks[0].task_id })).body;
    // unknown tool name -> env returns an error observation (HTTP 200), step still advances
    const unknown = await post("/step", { session, action: { name: "bogus_tool", arguments: {} } });
    assert.equal(unknown.status, 200);
    assert.match(unknown.body.observation, /unknown tool/);
    assert.equal(unknown.body.step, 1);
    // structurally malformed action (null) -> sidecar catch -> HTTP 400 with error
    const bad = await post("/step", { session, action: null });
    assert.equal(bad.status, 400);
    assert.ok(typeof bad.body.error === "string" && bad.body.error.length > 0);
    // sidecar still alive and serving after the error
    assert.equal((await get("/pool?split=dev")).status, 200);
  });

  it("exit/termination: done flips at the step budget and stepping after termination is rejected", async () => {
    const pool = (await get("/pool?split=dev")).body;
    const { session } = (await post("/reset", { taskId: pool.tasks[0].task_id })).body;
    let done = false;
    let steps = 0;
    for (; steps < 50 && !done; steps += 1) {
      const r = await post("/step", { session, action: { name: "api_search", arguments: { query: "crm" } } });
      assert.equal(r.status, 200);
      done = r.body.done;
    }
    assert.equal(done, true, "episode must terminate at the step budget");
    // any further step after termination is rejected (env throws -> 400)
    const after = await post("/step", { session, action: { name: "api_search", arguments: { query: "x" } } });
    assert.equal(after.status, 400);
    assert.match(after.body.error, /terminated/);
  });

  it("POST /score returns numeric reward/steps/forbidden_effects and 404s an unknown session", async () => {
    const pool = (await get("/pool?split=dev")).body;
    const { session } = (await post("/reset", { taskId: pool.tasks[0].task_id })).body;
    await post("/step", { session, action: { name: "api_fetch", arguments: { method: "GET", url: "/crm/contacts" } } });
    const score = await post("/score", { session });
    assert.equal(score.status, 200);
    assert.equal(typeof score.body.reward, "number");
    assert.ok(score.body.reward >= 0 && score.body.reward <= 1);
    assert.equal(typeof score.body.steps, "number");
    assert.equal(typeof score.body.forbidden_effects, "number");
    assert.equal((await post("/score", { session: "999999" })).status, 404);
    assert.equal((await post("/step", { session: "999999", action: { name: "api_search", arguments: {} } })).status, 404);
  });
});
