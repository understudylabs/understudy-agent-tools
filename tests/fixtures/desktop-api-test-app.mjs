import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const capabilityPath = process.env.UNDERSTUDY_DESKTOP_API_FILE;
if (!capabilityPath) throw new Error("UNDERSTUDY_DESKTOP_API_FILE is required");
const token = randomBytes(32).toString("hex");
const server = createServer((request, response) => {
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
      api_version: "2.2.0",
    }));
    return;
  }
  if (request.url === "/v1/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ app: "running", app_version: "fixture-app", repair_required: false }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  mkdirSync(dirname(capabilityPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(capabilityPath), 0o700);
  writeFileSync(capabilityPath, `${JSON.stringify({
    schema_version: "understudy.desktop_api.v2",
    api_version: "2.2.0",
    base_url: `http://127.0.0.1:${address.port}`,
    pid: process.pid,
    app_version: "fixture-app",
    token,
  })}\n`, { mode: 0o600 });
  chmodSync(capabilityPath, 0o600);
  process.stdout.write("fixture desktop ready\n");
});

function stop() {
  rmSync(capabilityPath, { force: true });
  server.close(() => process.exit(0));
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
