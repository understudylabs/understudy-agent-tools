import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export function serveTraceFoundry(benchmarkInput: string, port = 3003, host = "127.0.0.1"): Server {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  const root = resolve(benchmarkInput, "viewer"), prefix = `${root}${sep}`;
  if (!existsSync(join(root, "index.html"))) throw new Error(`Benchmark viewer not found: ${root}`);
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://${host}`).pathname);
      const candidate = resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
      if (candidate !== root && !candidate.startsWith(prefix)) { response.writeHead(403).end("forbidden"); return; }
      if (!existsSync(candidate) || !statSync(candidate).isFile()) { response.writeHead(404).end("not found"); return; }
      const mime = extname(candidate) === ".json" ? "application/json" : "text/html; charset=utf-8";
      response.writeHead(200, { "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(readFileSync(candidate));
    } catch { response.writeHead(400).end("bad request"); }
  });
  server.listen(port, host); return server;
}
