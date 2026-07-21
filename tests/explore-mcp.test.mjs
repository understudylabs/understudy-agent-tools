import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const bin = resolve("dist/bin.js");

function run(args, env = {}) {
  return spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: undefined, ...env },
  });
}

// minimal JSON-RPC-over-stdio MCP client against `understudy explore mcp`
function mcpSession(requests, { timeoutMs = 15000, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [bin, "explore", "mcp"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const expected = requests.filter((r) => r.id !== undefined).length;
    const responses = new Map();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout; got ${responses.size}/${expected} responses`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // any non-JSON on stdout is a protocol violation → test fails
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.size === expected) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(responses);
        }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}

const initialize = {
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "explore-mcp-test", version: "0.0.0" },
  },
};
const initialized = { method: "notifications/initialized", params: {} };

describe("explore mcp", () => {
  it("help lists mcp and mcp-install", () => {
    const res = run(["explore", "--help"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^  mcp /m);
    assert.match(res.stdout, /^  mcp-install /m);
  });

  it("handshakes and lists the six tools over stdio", async () => {
    const responses = await mcpSession([
      initialize,
      initialized,
      { id: 2, method: "tools/list", params: {} },
    ]);
    const init = responses.get(1);
    assert.equal(init.result.serverInfo.name, "understudy-explore");
    const names = responses.get(2).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "explore_status",
      "explore_tasks",
      "file_attention",
      "list_sessions",
      "open",
      "search_sessions",
    ]);
    const search = responses.get(2).result.tools.find((t) => t.name === "search_sessions");
    assert.deepEqual(search.inputSchema.properties.mode.enum, ["bm25", "keyword", "both"]);
  });

  it("explore_status answers even with no scan data and unreachable clickhouse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-explore-mcp-"));
    try {
      const responses = await mcpSession(
        [initialize, initialized, { id: 2, method: "tools/call", params: { name: "explore_status", arguments: {} } }],
        { env: { UNDERSTUDY_EXPLORE_DIR: dir, MORAINE_CLICKHOUSE_URL: "http://127.0.0.1:9" } },
      );
      const status = JSON.parse(responses.get(2).result.content[0].text);
      assert.equal(status.clickhouse_reachable, false);
      assert.equal(status.has_scan, false);
      assert.match(status.hint, /understudy explore scan/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mcp-install --dry-run plans the takeover without writing", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-mcp-home-"));
    try {
      const configPath = join(home, ".claude.json");
      const before = { mcpServers: { moraine: { type: "stdio", command: "moraine", args: ["run", "mcp"], env: {} } } };
      writeFileSync(configPath, JSON.stringify(before, null, 2));
      const res = run(["explore", "mcp-install", "--dry-run"], { HOME: home });
      assert.equal(res.status, 0);
      assert.match(res.stdout, /remove mcpServers\.moraine/);
      assert.match(res.stdout, /mcpServers\.understudy/);
      assert.match(res.stdout, /dry run/);
      assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), before); // untouched
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("mcp-install replaces moraine with understudy and leaves a backup", () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-mcp-home-"));
    try {
      const configPath = join(home, ".claude.json");
      writeFileSync(
        configPath,
        JSON.stringify({ other: true, mcpServers: { moraine: { type: "stdio", command: "moraine", args: ["run", "mcp"] } } }),
      );
      const res = run(["explore", "mcp-install"], { HOME: home });
      assert.equal(res.status, 0);
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(after.mcpServers.moraine, undefined);
      assert.deepEqual(after.mcpServers.understudy, {
        type: "stdio",
        command: "understudy",
        args: ["explore", "mcp"],
        env: {},
      });
      assert.equal(after.other, true);
      const backups = readdirSync(home).filter((f) => f.startsWith(".claude.json.bak-"));
      assert.equal(backups.length, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
