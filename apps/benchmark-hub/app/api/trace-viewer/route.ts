import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the captures/flags routes.
import { getEntry } from "../../../lib/data-core";
import {
  buildTaskTraceViewer,
  loadRenderTraceViewer,
  taskTraceGroups,
} from "../../../lib/trace-viewer-core";

export const dynamic = "force-dynamic";

/** The only files this route will ever serve, with their content types. */
const SERVABLE: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "trace-data.js": "text/javascript; charset=utf-8",
};

/**
 * GET /api/trace-viewer?slug=<hub slug>&task=<task_id>
 *   → JSON list of the task's trace timelines (one per trace id; `null`
 *     trace_id = the captures carry no trace context and share one timeline).
 *
 * GET /api/trace-viewer?slug&task[&trace=<trace_id>]&file=index.html|trace-data.js
 *   → lazily builds the viewer via the CLI's renderTraceViewer into
 *     <benchmark-dir>/.trace-viewer-cache/ (cache-hit skips the rebuild) and
 *     serves the named artifact. `file` is a strict allowlist and `trace`
 *     must match an enumerated trace id — no client-supplied value ever
 *     becomes a filesystem path (cache dirs are keyed by hashes). Payloads
 *     are only served through here, never embedded in an RSC.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const task = url.searchParams.get("task");
  const trace = url.searchParams.get("trace");
  const file = url.searchParams.get("file");
  if (!slug || !task) {
    return NextResponse.json({ error: "slug and task query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") {
    return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  }

  const groups = taskTraceGroups(entry.dir, task);
  if (groups.length === 0) {
    return NextResponse.json({ error: "no capture bodies on disk for this task" }, { status: 404 });
  }

  if (!file) {
    // List mode — what timelines exist and how to open them.
    const base = `/api/trace-viewer?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(task)}`;
    return NextResponse.json({
      task_id: task,
      traces: groups.map((g) => ({
        trace_id: g.traceId,
        captures: g.captureFiles.length,
        href: `${base}${g.traceId ? `&trace=${encodeURIComponent(g.traceId)}` : ""}&file=index.html`,
      })),
    });
  }

  const contentType = SERVABLE[file];
  if (!contentType) {
    return NextResponse.json({ error: "file must be index.html or trace-data.js" }, { status: 400 });
  }
  const traceId = trace ?? null;
  if (!groups.some((g) => g.traceId === traceId)) {
    return NextResponse.json({ error: "unknown trace id for this task" }, { status: 404 });
  }

  const render = await loadRenderTraceViewer();
  if (!render) {
    return NextResponse.json(
      { error: "trace viewer unavailable — build the CLI first (npm run build at the repo root)" },
      { status: 503 },
    );
  }

  let built: { cacheDir: string } | null;
  try {
    built = await buildTaskTraceViewer(entry.dir, task, traceId, render);
  } catch (error) {
    return NextResponse.json({ error: `trace viewer build failed: ${String(error)}` }, { status: 500 });
  }
  if (!built) {
    return NextResponse.json({ error: "no capture bodies on disk for this task" }, { status: 404 });
  }

  let body: string;
  try {
    body = fs.readFileSync(path.join(built.cacheDir, file), "utf8");
  } catch {
    return NextResponse.json({ error: "viewer artifact missing after build" }, { status: 500 });
  }
  if (file === "index.html") {
    // The template loads its sibling via a relative src, which a query-string
    // URL cannot satisfy — point it back at this route (serve-time rewrite
    // only; the cached artifact on disk stays viewer-contract pristine).
    const dataHref =
      `/api/trace-viewer?slug=${encodeURIComponent(slug)}&task=${encodeURIComponent(task)}` +
      `${traceId ? `&trace=${encodeURIComponent(traceId)}` : ""}&file=trace-data.js`;
    body = body.replace('src="./trace-data.js"', `src="${dataHref.replaceAll("&", "&amp;")}"`);
    // Theme pass-through: the template has no query/postMessage theme input,
    // only the contract's :root[data-theme] override (it follows the system
    // scheme otherwise) — so forward the hub's `theme` cookie at serve time.
    const themeCookie = /(?:^|;\s*)theme=(light|dark)(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (themeCookie) body = body.replace('<html lang="en">', `<html lang="en" data-theme="${themeCookie}">`);
  }
  return new NextResponse(body, {
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
