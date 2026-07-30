import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type ScorecardEntry = {
  slug: string;
  directory: string;
  viewer: string;
  name: string;
  benchmark_id: string;
  rollouts: number;
  verifier_version: string;
};

function embeddedData(html: string): Record<string, unknown> {
  const match = html.match(/const D=(\{[\s\S]*?\});\s*let selected=/);
  if (!match) return {};
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function discoverPrimeScorecards(root: string): ScorecardEntry[] {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) return [];
  return readdirSync(resolvedRoot)
    .flatMap((slug) => {
      const directory = join(resolvedRoot, slug);
      if (!statSync(directory).isDirectory()) return [];
      const viewer = join(directory, "viewer", "index.html");
      if (!existsSync(viewer)) return [];
      const data = embeddedData(readFileSync(viewer, "utf8"));
      const benchmarkId = typeof data.benchmark_id === "string" ? data.benchmark_id : slug;
      const publicSlug = benchmarkId.replace(/-v\d+$/, "");
      return [{
        slug: publicSlug,
        directory,
        viewer,
        name: typeof data.name === "string" ? data.name : slug,
        benchmark_id: benchmarkId,
        rollouts: Array.isArray(data.rollouts) ? data.rollouts.length : 0,
        verifier_version: typeof data.verifier_version === "string" ? data.verifier_version : "unknown",
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderScorecardGallery(entries: ScorecardEntry[]): string {
  const cards = entries.length
    ? entries.map((entry) => `<a class="card" href="/b/${encodeURIComponent(entry.slug)}/"><span>${escapeHtml(entry.name)}</span><b>${entry.rollouts} rollouts</b><small>${escapeHtml(entry.benchmark_id)} · Prime ${escapeHtml(entry.verifier_version)}</small></a>`).join("")
    : '<div class="empty">No scorecards found. Run <code>understudy benchmarks build-scorecard &lt;config&gt;</code>.</div>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Understudy Benchmark Gallery</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#030303;color:#e8e8e6;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1100px;margin:0 auto;padding:48px 24px}h1{font-size:22px;font-weight:500;margin:0 0 8px}.sub{color:#777;margin-bottom:32px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.card{display:block;border:1px solid #252525;border-radius:12px;padding:18px;color:inherit;text-decoration:none;background:#080808}.card:hover{border-color:#4de49a}.card span,.card b,.card small{display:block}.card b{margin:18px 0 5px;color:#4de49a;font-size:18px}.card small,.empty{color:#777}code{color:#bbb}</style></head><body><main><h1>Benchmark Gallery</h1><div class="sub">Private Prime-native scorecards · ${entries.length} benchmark${entries.length === 1 ? "" : "s"}</div><div class="grid">${cards}</div></main></body></html>`;
}

export function startPrimeScorecardServer(root: string, port: number, host = "127.0.0.1"): Promise<{ server: Server; url: string; entries: ScorecardEntry[] }> {
  const entries = discoverPrimeScorecards(root);
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderScorecardGallery(entries));
      return;
    }
    const match = /^\/b\/([^/]+)\/?(?:index\.html)?$/.exec(url.pathname);
    if (match) {
      const slug = decodeURIComponent(match[1]);
      const entry = bySlug.get(slug);
      if (entry) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(readFileSync(entry.viewer));
        return;
      }
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise({ server, url: `http://${host}:${port}/`, entries }));
  });
}
