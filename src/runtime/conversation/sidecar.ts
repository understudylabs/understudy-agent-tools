import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFORMANCE_SCHEMA,
  EVENT_SCHEMA,
  RUNTIME_ID,
  RUNTIME_VERSION,
  safeErrorMessage,
} from "./contract.js";
import { runVercelConversation } from "./vercel-runtime.js";

const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedPort(): number {
  const raw = option("--port") ?? process.env.UNDERSTUDY_RUNTIME_PORT ?? "0";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("runtime port must be an integer from 0 to 65535");
  }
  return port;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("runtime request exceeds the 40 MB limit");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function writeState(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function startConversationSidecar(options: {
  port?: number;
  stateFile?: string;
  token?: string;
} = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const token = options.token ?? process.env.UNDERSTUDY_RUNTIME_TOKEN;
  if (!token) {
    throw new Error(
      "UNDERSTUDY_RUNTIME_TOKEN is required; start this runtime through the Understudy CLI",
    );
  }
  const controllers = new Map<string, AbortController>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        runtime_id: RUNTIME_ID,
        runtime_version: RUNTIME_VERSION,
        event_schema: EVENT_SCHEMA,
        conformance_schema: CONFORMANCE_SCHEMA,
        active_runs: controllers.size,
      });
      return;
    }
    if (!authorized(request, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/runs") {
      let payload: unknown;
      try {
        payload = await readJson(request);
      } catch (error) {
        sendJson(response, 400, { error: safeErrorMessage(error) });
        return;
      }
      const runId =
        typeof payload === "object" && payload !== null && "run_id" in payload
          ? String(payload.run_id)
          : "";
      if (!runId) {
        sendJson(response, 400, { error: "run_id is required" });
        return;
      }
      if (controllers.has(runId)) {
        sendJson(response, 409, { error: "run_id is already active" });
        return;
      }
      const controller = new AbortController();
      controllers.set(runId, controller);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.on("close", () => {
        if (!response.writableEnded) controller.abort("client_disconnected");
      });
      try {
        await runVercelConversation(
          payload,
          (event) => {
            if (!response.writableEnded && !response.destroyed) {
              response.write(`${JSON.stringify(event)}\n`);
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (!response.writableEnded && !response.destroyed) {
          response.write(`${JSON.stringify({ error: safeErrorMessage(error) })}\n`);
        }
      } finally {
        controllers.delete(runId);
        if (!response.writableEnded && !response.destroyed) response.end();
      }
      return;
    }
    const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (request.method === "DELETE" && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1]);
      const controller = controllers.get(runId);
      if (!controller) {
        sendJson(response, 404, { error: "run not found" });
        return;
      }
      controller.abort("cancelled_by_client");
      sendJson(response, 200, { status: "cancelling", run_id: runId });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });

  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? requestedPort(), "127.0.0.1", () => accept());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("conversation runtime did not receive a TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const stateFile = options.stateFile ?? option("--state-file");
  if (stateFile) {
    writeState(stateFile, {
      schema_version: "understudy-conversation-runtime-state-v1",
      pid: process.pid,
      base_url: baseUrl,
      runtime_id: RUNTIME_ID,
      runtime_version: RUNTIME_VERSION,
      event_schema: EVENT_SCHEMA,
      started_at: new Date().toISOString(),
    });
  }

  const close = async () => {
    for (const controller of controllers.values()) controller.abort("runtime_stopping");
    await new Promise<void>((accept) => server.close(() => accept()));
    if (stateFile) rmSync(stateFile, { force: true });
  };
  return { baseUrl, close };
}

async function main(): Promise<void> {
  const stateFile = option("--state-file");
  const runtime = await startConversationSidecar({ stateFile });
  process.stdout.write(
    `${JSON.stringify({
      understudy_runtime: "ready",
      runtime_id: RUNTIME_ID,
      runtime_version: RUNTIME_VERSION,
      event_schema: EVENT_SCHEMA,
      base_url: runtime.baseUrl,
    })}\n`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  await main();
}
