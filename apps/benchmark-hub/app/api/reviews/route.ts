import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { getEntry, submitReview } from "../../../lib/data-core";

export const dynamic = "force-dynamic";

/**
 * POST { slug, task_id, decision, note } →
 * appends one understudy.benchmark_review.v1 line to reviews.jsonl next to the
 * foundry manifest. Append-only; the newest line per task_id supersedes older
 * ones. Read-only (fixture) entries are rejected. Mirrors /api/flags.
 *
 * All validation + the append itself live in the shared submitReview
 * (dist/benchmark-hub-core.js) — the same function `understudy benchmarks
 * mcp` submit_review uses; this route only maps HTTP.
 */
export async function POST(request: Request) {
  let body: { slug?: string; task_id?: string; decision?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // getEntry resolves the slug prefix to one scan root and reads only the
  // target directory — a review POST never rescans every benchmark.
  const entry = body.slug ? getEntry(body.slug) : null;
  const result = submitReview(entry, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, review: result.review });
}
