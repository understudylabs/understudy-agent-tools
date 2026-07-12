import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const cli = ["node", resolve("dist/bin.js")];
const root = mkdtempSync(join(tmpdir(), "understudy-desktop-api-"));
const capabilityPath = join(root, "desktop-api.json");
const imagePath = join(root, "shelf.png");
const token = "desktop-api-test-token-".padEnd(64, "a");
let server;
let port;
let lastTurn;
let lastFeedback;
const mcpCalls = [];
const controlCalls = [];

function runCli(args) {
  return new Promise((accept, reject) => {
    const child = spawn(cli[0], [cli[1], ...args], {
      env: {
        ...process.env,
        UNDERSTUDY_DESKTOP_API_FILE: capabilityPath,
        UNDERSTUDY_TELEMETRY: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => accept({ status, stdout, stderr }));
  });
}

function envelope(sequence, event, data) {
  return {
    schema_version: "understudy-conversation-runtime-event-v1",
    event_id: `run-desktop:${sequence}`,
    run_id: "run-desktop",
    session_id: "session-desktop",
    runtime_id: "understudy-pi-runtime-v1",
    sequence,
    emitted_at: "2026-07-12T00:00:00Z",
    event,
    data,
  };
}

before(async () => {
  server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200);
      response.end("ok");
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "understudy.desktop_api.v2",
        api_version: "2.1.0",
        event_schema: "understudy-conversation-runtime-event-v1",
      }));
      return;
    }
    if (request.url === "/v1/status") {
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(404);
      response.end("old desktop without versioned control routes");
      return;
    }
    if (request.url === "/api/status") {
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ app: "running", repair_required: false }));
      return;
    }
    if (
      request.method === "GET"
      && [
        "/v1/metrics/chat-routes?limit=100",
        "/v1/metrics/chat-routes?limit=99",
      ].includes(request.url)
    ) {
      const ready = request.url.endsWith("=100");
      controlCalls.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schema_version: "understudy.chat_route_metrics.v1",
        app_version: "0.2.5",
        runtime_version: "0.3.3",
        observed_row_limit: ready ? 100 : 99,
        required_canonical_runtime_rows: 100,
        remaining_canonical_runtime_rows: ready ? 0 : 1,
        canonical_runtime_rows: ready ? 100 : 99,
        pi_runtime_rows: ready ? 100 : 98,
        compatibility_fallback_rows: ready ? 0 : 1,
        pi_runtime_share: ready ? 1 : 98 / 99,
        compatibility_engine_delete_ready: ready,
        groups: [],
      }));
      return;
    }
    const controlValues = {
      "GET /v1/models": [{ id: "understudy-small", ready: true }],
      "GET /v1/models/catalog": [{ id: "understudy-small", tier: "small" }],
      "GET /v1/residency": {
        slots: [{ id: 7, state: "running", model_id: "understudy-small" }],
        used_gb: 2,
        usable_gb: 8,
      },
      "POST /v1/residency/slots": { ok: true, slot_id: 8 },
      "POST /v1/residency/assign": { ok: true, slot_id: 7 },
      "POST /v1/residency/warm": { ok: true, slot_id: 7, state: "loading" },
      "POST /v1/residency/cool": { ok: true, slot_id: 7 },
      "POST /v1/residency/remove": { ok: true, slot_id: 7 },
      "GET /v1/downloads": { downloads: [] },
      "POST /v1/downloads": {
        ok: true,
        download_id: "download-1",
        model_id: "understudy-small",
      },
      "GET /v1/downloads/download-1": {
        id: "download-1", model_id: "understudy-small", status: "running",
      },
      "POST /v1/downloads/download-1/cancel": {
        id: "download-1", model_id: "understudy-small", status: "cancelled",
      },
    };
    const controlKey = `${request.method} ${request.url}`;
    if (controlKey in controlValues) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      controlCalls.push({
        method: request.method,
        url: request.url,
        body: raw ? JSON.parse(raw) : undefined,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(controlValues[controlKey]));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/conversations/session-desktop/turns") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      lastTurn = JSON.parse(raw);
      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "x-understudy-run-id": "run-desktop",
      });
      response.write(`${JSON.stringify(envelope(0, "message", { role: "user", text: "inspect" }))}\n`);
      response.write(`${JSON.stringify(envelope(1, "delta", { role: "primary", text: "Shelf looks good." }))}\n`);
      response.end(`${JSON.stringify(envelope(2, "usage", {
        role: "primary", input_tokens: 10, output_tokens: 3, total_tokens: 13,
        reasoning_tokens: 0, cached_input_tokens: 0, source: "provider", complete: true,
      }))}\n`);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/runs/run-desktop/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify(envelope(0, "delta", { role: "primary", text: "persisted" }))}\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runs/run-desktop/cancel") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, status: "cancelling", run_id: "run-desktop" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/feedback/supervisor") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      lastFeedback = JSON.parse(raw);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/mcp") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      mcpCalls.push(message);
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const values = {
        status: { app: "running", repair_required: false },
        list_models: [{ id: "understudy-small", ready: true }],
        list_snapshot_models: [{ id: "understudy-small", tier: "small" }],
        residency: [{ slot_id: 7, state: "running", model_id: "understudy-small" }],
        add_slot: { ok: true, slot_id: 8 },
        assign_slot: { ok: true, slot_id: args.slot_id },
        warm_slot: { ok: true, slot_id: args.slot_id, state: "loading" },
        cool_slot: { ok: true, slot_id: args.slot_id },
        remove_slot: { ok: true, slot_id: args.slot_id },
        list_model_downloads: { downloads: [] },
        start_model_download: {
          ok: true,
          download_id: "download-1",
          model_id: args.model_id,
        },
        model_download_status: { id: args.download_id, status: "running" },
        cancel_model_download: { id: args.download_id, status: "cancelled" },
      };
      if (!(name in values)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: `unknown tool ${name}` },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { structuredContent: values[name] },
      }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  port = server.address().port;
  writeFileSync(capabilityPath, JSON.stringify({
    schema_version: "understudy.desktop_api.v2",
    base_url: `http://127.0.0.1:${port}`,
    pid: process.pid,
    app_version: "test",
    token,
  }), { mode: 0o600 });
  writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4z8AAAAASUVORK5CYII=", "base64"));
});

after(async () => {
  await new Promise((accept) => server.close(accept));
  rmSync(root, { recursive: true, force: true });
});

describe("desktop API CLI", () => {
  it("ships an offline OpenAPI contract for every implemented v2 operation", async () => {
    const result = await runCli(["desktop", "contract", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const contract = JSON.parse(result.stdout);
    assert.equal(contract.openapi, "3.1.0");
    assert.equal(contract.info.version, "2.1.0");
    assert.deepEqual(Object.keys(contract.paths).sort(), [
      "/v1/capabilities",
      "/v1/conversations/{session_id}/turns",
      "/v1/downloads",
      "/v1/downloads/{download_id}",
      "/v1/downloads/{download_id}/cancel",
      "/v1/feedback/supervisor",
      "/v1/metrics/chat-routes",
      "/v1/models",
      "/v1/models/catalog",
      "/v1/residency",
      "/v1/residency/assign",
      "/v1/residency/cool",
      "/v1/residency/remove",
      "/v1/residency/slots",
      "/v1/residency/warm",
      "/v1/runs/{run_id}/cancel",
      "/v1/runs/{run_id}/events",
      "/v1/status",
    ]);
    assert.deepEqual(
      contract.components.schemas.RuntimeEventEnvelope.properties.event.enum,
      [
        "message", "delta", "reasoning_delta", "tool_call", "tool_result", "usage",
        "supervisor_verdict", "student_interruption", "teacher_continuation",
        "cancellation", "error", "image_attachment", "compaction_boundary",
      ],
    );
    assert.equal(contract.security[0].desktopBearer.length, 0);
  });

  it("discovers the authenticated v2 capability contract", async () => {
    const result = await runCli(["desktop", "capabilities", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.schema_version, "understudy.desktop_api.v2");
    assert.equal(value.api_version, "2.1.0");
  });

  it("exposes a fail-closed release observation gate for Rust fallback deletion", async () => {
    const ready = await runCli([
      "desktop", "migration-status", "--limit", "100", "--require-ready", "--json",
    ]);
    assert.equal(ready.status, 0, ready.stderr);
    const value = JSON.parse(ready.stdout);
    assert.equal(value.canonical_runtime_rows, 100);
    assert.equal(value.compatibility_fallback_rows, 0);
    assert.equal(value.remaining_canonical_runtime_rows, 0);
    assert.equal(value.compatibility_engine_delete_ready, true);

    const observing = await runCli([
      "desktop", "migration-status", "--limit", "99", "--require-ready", "--json",
    ]);
    assert.equal(observing.status, 2, observing.stderr);
    const pending = JSON.parse(observing.stdout);
    assert.equal(pending.compatibility_fallback_rows, 1);
    assert.equal(pending.remaining_canonical_runtime_rows, 1);
    assert.equal(pending.compatibility_engine_delete_ready, false);
  });

  it("operates model downloads and residency through versioned REST with one-release fallback", async () => {
    const initialControlCallCount = controlCalls.length;
    const status = await runCli(["desktop", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).app, "running");

    const catalog = await runCli(["desktop", "model", "catalog", "--json"]);
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.equal(JSON.parse(catalog.stdout)[0].id, "understudy-small");

    const models = await runCli(["desktop", "model", "list", "--json"]);
    assert.equal(models.status, 0, models.stderr);
    assert.equal(JSON.parse(models.stdout)[0].ready, true);

    const slots = await runCli(["desktop", "slot", "list", "--json"]);
    assert.equal(slots.status, 0, slots.stderr);
    assert.equal(JSON.parse(slots.stdout).slots[0].id, 7);

    const added = await runCli(["desktop", "slot", "add", "--json"]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).slot_id, 8);

    const started = await runCli([
      "desktop", "download", "start", "understudy-small", "--json",
    ]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).download_id, "download-1");

    const assigned = await runCli([
      "desktop", "slot", "assign", "7", "understudy-small", "--json",
    ]);
    assert.equal(assigned.status, 0, assigned.stderr);
    assert.equal(JSON.parse(assigned.stdout).slot_id, 7);

    const warmed = await runCli(["desktop", "slot", "warm", "7", "--json"]);
    assert.equal(warmed.status, 0, warmed.stderr);
    assert.equal(JSON.parse(warmed.stdout).state, "loading");

    const cooled = await runCli(["desktop", "slot", "cool", "7", "--json"]);
    assert.equal(cooled.status, 0, cooled.stderr);

    const removed = await runCli(["desktop", "slot", "remove", "7", "--json"]);
    assert.equal(removed.status, 0, removed.stderr);

    const downloads = await runCli(["desktop", "download", "list", "--json"]);
    assert.equal(downloads.status, 0, downloads.stderr);
    assert.deepEqual(JSON.parse(downloads.stdout).downloads, []);

    const download = await runCli([
      "desktop", "download", "status", "download-1", "--json",
    ]);
    assert.equal(download.status, 0, download.stderr);
    assert.equal(JSON.parse(download.stdout).status, "running");

    const cancelled = await runCli([
      "desktop", "download", "cancel", "download-1", "--json",
    ]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

    const calls = controlCalls.slice(initialControlCallCount);
    assert.deepEqual(calls.map((call) => call.url), [
      "/v1/status",
      "/api/status",
      "/v1/models/catalog",
      "/v1/models",
      "/v1/residency",
      "/v1/residency/slots",
      "/v1/downloads",
      "/v1/residency/assign",
      "/v1/residency/warm",
      "/v1/residency/cool",
      "/v1/residency/remove",
      "/v1/downloads",
      "/v1/downloads/download-1",
      "/v1/downloads/download-1/cancel",
    ]);
    assert.deepEqual(calls.find((call) => call.url === "/v1/residency/assign").body, {
      slot_id: 7,
      model_id: "understudy-small",
    });
    assert.equal(mcpCalls.length, 0, "the public CLI must not tunnel stable controls through MCP");
  });

  it("streams canonical image-chat events with caller-owned identity", async () => {
    const result = await runCli([
      "desktop", "chat", "inspect", "--slot", "7", "--session", "session-desktop",
      "--supervisor-slot", "5", "--run-id", "run-desktop", "--image", imagePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["message", "delta", "usage"]);
    assert.equal(lastTurn.slotId, 7);
    assert.equal(lastTurn.supervisorSlotId, 5);
    assert.equal(lastTurn.runId, "run-desktop");
    assert.equal(lastTurn.attachments[0].mediaType, "image/png");
    assert.match(lastTurn.attachments[0].dataUrl, /^data:image\/png;base64,/);
  });

  it("replays and cancels the exact run", async () => {
    const replay = await runCli(["desktop", "run", "events", "run-desktop", "--json"]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).data.text, "persisted");

    const cancel = await runCli(["desktop", "run", "cancel", "run-desktop", "--json"]);
    assert.equal(cancel.status, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).run_id, "run-desktop");
  });

  it("records an explicit supervisor judgment", async () => {
    const result = await runCli([
      "desktop", "supervisor-feedback", "--session", "session-desktop",
      "--run-id", "run-desktop", "--marker", "marker-1", "--stage", "take_over",
      "--correct-action", "continue", "--justification", "false positive", "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lastFeedback.helpful, false);
    assert.equal(lastFeedback.correctAction, "continue");
    assert.equal(lastFeedback.markerId, "marker-1");

    const missed = await runCli([
      "desktop", "supervisor-feedback", "--session", "session-desktop",
      "--run-id", "run-desktop", "--marker", "run-desktop:verdict:0", "--stage", "stop",
      "--correct-action", "interrupt", "--justification", "missed known error", "--json",
    ]);
    assert.equal(missed.status, 0, missed.stderr);
    assert.equal(lastFeedback.helpful, false);
    assert.equal(lastFeedback.stage, "stop");
    assert.equal(lastFeedback.correctAction, "interrupt");
    assert.equal(lastFeedback.markerId, "run-desktop:verdict:0");
  });
});
