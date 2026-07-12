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
        event_schema: "understudy-conversation-runtime-event-v1",
      }));
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
    assert.equal(contract.info.version, "2.0.0");
    assert.deepEqual(Object.keys(contract.paths).sort(), [
      "/v1/capabilities",
      "/v1/conversations/{session_id}/turns",
      "/v1/feedback/supervisor",
      "/v1/runs/{run_id}/cancel",
      "/v1/runs/{run_id}/events",
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
  });

  it("streams canonical image-chat events with caller-owned identity", async () => {
    const result = await runCli([
      "desktop", "chat", "inspect", "--slot", "7", "--session", "session-desktop",
      "--run-id", "run-desktop", "--image", imagePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.event), ["message", "delta", "usage"]);
    assert.equal(lastTurn.slotId, 7);
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
  });
});
