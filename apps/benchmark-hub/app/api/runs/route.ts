import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly, same as the flags/reviews routes.
import { getEntry, queueOrCancelRun, type QueueRunBody } from "../../../lib/data-core";
import { listRunRequests } from "../../../lib/runs-core";

export const dynamic = "force-dynamic";

/**
 * The run queue API. The hub NEVER executes models: POST only writes an
 * understudy.run_request.v1 file into <benchmark-dir>/runs/queue/ (or flips
 * one to cancelled); `understudy runs execute --benchmark <dir> [--watch]`
 * is what picks requests up. GET re-reads the queue files for live status.
 *
 * All validation + the queue/cancel writes live in the shared
 * queueOrCancelRun (dist/benchmark-hub-core.js) — the same function
 * `understudy benchmarks mcp` queue_run uses; this route only maps HTTP.
 * Hardening mirrors /api/flags: slug resolves through getEntry (prefix →
 * one scan root, no rescans), read-only sources are rejected, only PROMOTED
 * benchmarks take full runs (proposed = accepted single tasks only).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug query param is required" }, { status: 400 });
  const entry = getEntry(slug);
  if (!entry || entry.kind === "invalid") return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  // Proposed entries list too: accepted tasks run pre-promotion.
  return NextResponse.json({ runs: listRunRequests(entry.dir) });
}

export async function POST(request: Request) {
  let body: QueueRunBody & { slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = body.slug ? getEntry(body.slug) : null;
  const result = queueOrCancelRun(entry, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (result.execute_hint === undefined) return NextResponse.json({ ok: true, run: result.run });
  return NextResponse.json({ ok: true, run: result.run, execute_hint: result.execute_hint });
}
