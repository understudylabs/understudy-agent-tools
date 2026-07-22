import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { applyAutoAccepts, getEntry } from "../../../../lib/data-core";

export const dynamic = "force-dynamic";

/**
 * POST { slug } → apply the auto-accept policy: recompute
 * deriveAutoReviewProposals against the entry as loaded and append one
 * `accept` line per AUTO_ACCEPT task to reviews.jsonl, stamped
 * `source: "auto"`. This route exists ONLY behind the explicit
 * "Apply N auto-accepts" click — the hub never writes auto-decisions on page
 * load. Reversible: reviews.jsonl stays append-only, newest line per task
 * wins, so any human decision (including via the per-task review bar)
 * supersedes an auto line.
 *
 * All validation + the appends live in the shared applyAutoAccepts
 * (dist/benchmark-hub-core.js); this route only maps HTTP.
 */
export async function POST(request: Request) {
  let body: { slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = body.slug ? getEntry(body.slug) : null;
  const result = applyAutoAccepts(entry);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, applied: result.applied, exceptions: result.exceptions });
}
