import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  daemonStatus,
  daemonMcpRequest,
  describeDaemon,
  pidAlive,
  probeDaemonHealth,
  readAgentCard,
} from "../dist/internal/daemon.js";

/** A pid that existed and has exited: spawn a no-op node child and reap it. */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid;
}

function writeCard(cardPath, app) {
  writeFileSync(
    cardPath,
    JSON.stringify(
      {
        schema_version: "understudy.agent_card.v1",
        created_at: "2026-06-06T18:00:00Z",
        updated_at: "2026-06-06T18:05:00Z",
        understudy: { name: "Gemma 4 E2B", healthy: true },
        ...(app === undefined ? {} : { app }),
      },
      null,
      2,
    ),
  );
}

describe("desktop-app daemon discovery from the agent card", () => {
  let dir;
  let cardPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "understudy-daemon-test-"));
    cardPath = join(dir, "agent-card.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports not detected when there is no card", async () => {
    const status = await daemonStatus({ cardPath });
    assert.equal(status.detected, false);
    assert.equal(status.running, false);
    assert.match(status.detail, /no agent card/);
    assert.match(describeDaemon(status), /^not detected/);
  });

  it("reports not detected when the card has no app block", async () => {
    writeCard(cardPath, undefined);
    const status = await daemonStatus({ cardPath });
    assert.equal(status.detected, false);
    assert.equal(status.running, false);
    assert.match(status.detail, /no app block/);
  });

  it("tolerates a corrupt card", async () => {
    writeFileSync(cardPath, "{not json");
    assert.equal(readAgentCard(cardPath), null);
    const status = await daemonStatus({ cardPath });
    assert.equal(status.running, false);
  });

  it("reports stopped when the app shut down gracefully", async () => {
    writeCard(cardPath, {
      running: false,
      pid: process.pid,
      stopped_at: "2026-06-06T19:00:00Z",
      base_url: "http://127.0.0.1:17790",
    });
    const status = await daemonStatus({ cardPath });
    assert.equal(status.detected, true);
    assert.equal(status.running, false);
    assert.match(status.detail, /marked stopped/);
  });

  it("running with a dead pid reports not running (stale card after a crash)", async () => {
    writeCard(cardPath, {
      running: true,
      pid: deadPid(),
      base_url: "http://127.0.0.1:17790",
      version: "0.2.2",
    });
    const status = await daemonStatus({ cardPath });
    assert.equal(status.detected, true);
    assert.equal(status.running, false);
    assert.match(status.detail, /pid \d+ is not alive/);
  });

  it("running with a live pid but unreachable base_url reports not running", async () => {
    writeCard(cardPath, {
      running: true,
      pid: process.pid,
      // Nothing listens here; connection is refused immediately.
      base_url: "http://127.0.0.1:1",
    });
    const status = await daemonStatus({ cardPath, timeoutMs: 500 });
    assert.equal(status.detected, true);
    assert.equal(status.running, false);
    assert.match(status.detail, /did not respond/);
  });
});

describe("daemon discovery against a live health endpoint", () => {
  let server;
  let baseUrl;
  const token = "test-token-that-is-long-enough-for-capability";

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.url === "/mcp" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "status" }] } }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  it("probeDaemonHealth answers true for a live /health", async () => {
    assert.equal(await probeDaemonHealth(baseUrl), true);
  });

  it("reports running when the card, pid, and health probe all agree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-daemon-live-"));
    const cardPath = join(dir, "agent-card.json");
    try {
      writeCard(cardPath, {
        running: true,
        pid: process.pid,
        base_url: baseUrl,
        version: "0.2.2",
        warm_models: [
          { id: "gemma-4-e2b-it-qat-mlx-vlm-understudy", port: 8089, model_path: "/m/e2b" },
          { id: "broken-row-without-strings", port: "not-a-port" },
        ],
      });
      const status = await daemonStatus({ cardPath });
      assert.equal(status.detected, true);
      assert.equal(status.running, true);
      assert.equal(status.baseUrl, baseUrl);
      assert.equal(status.pid, process.pid);
      assert.equal(status.version, "0.2.2");
      // Malformed warm rows are dropped, well-formed ones normalized.
      assert.equal(status.warmModels.length, 2);
      assert.equal(status.warmModels[0].id, "gemma-4-e2b-it-qat-mlx-vlm-understudy");
      assert.equal(status.warmModels[0].port, 8089);
      assert.equal(status.warmModels[1].port, null);
      assert.equal(describeDaemon(status), `running at ${baseUrl}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authenticates protected MCP calls through a matching owner-only capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-daemon-control-"));
    const cardPath = join(dir, "agent-card.json");
    const capabilityPath = join(dir, "desktop-api.json");
    try {
      writeCard(cardPath, {
        running: true,
        pid: process.pid,
        base_url: baseUrl,
        version: "0.3.1",
      });
      writeFileSync(
        capabilityPath,
        JSON.stringify({
          schema_version: "understudy.desktop_api.v1",
          base_url: baseUrl,
          mcp_url: `${baseUrl}/mcp`,
          pid: process.pid,
          token,
        }),
        { mode: 0o600 },
      );
      chmodSync(capabilityPath, 0o600);
      const status = await daemonStatus({ cardPath, capabilityPath });
      assert.equal(status.running, true);
      assert.equal(status.controlReady, true);
      const result = await daemonMcpRequest("tools/list", {}, { cardPath, capabilityPath });
      assert.deepEqual(result, { tools: [{ name: "status" }] });

      if (process.platform !== "win32") {
        chmodSync(capabilityPath, 0o644);
        const insecure = await daemonStatus({ cardPath, capabilityPath });
        assert.equal(insecure.controlReady, false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pidAlive", () => {
  it("is true for this process and false for a reaped child or nonsense", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(deadPid()), false);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-4), false);
    assert.equal(pidAlive(1.5), false);
  });
});
