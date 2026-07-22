import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { getEntry } from "../../../lib/data-core";
import { REVIEW_DECISIONS, type ReviewDecision } from "../../../lib/types";
// The review constructor + line serializer are the CLI's own (dist) — the
// writer side of reviews.jsonl can never drift from what promote consumes.
import { makeBenchmarkReview, serializeReviewLine } from "../../../lib/artifacts-core";

export const dynamic = "force-dynamic";

/** Hard cap on review note length (413 above this). */
const MAX_NOTE_LENGTH = 2000;

/**
 * POST { slug, task_id, decision, note } →
 * appends one understudy.benchmark_review.v1 line to reviews.jsonl next to the
 * foundry manifest. Append-only; the newest line per task_id supersedes older
 * ones. Read-only (fixture) entries are rejected. Mirrors /api/flags.
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
  if (!entry || entry.kind === "invalid") {
    return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  }
  if (entry.kind !== "proposed") {
    return NextResponse.json(
      { error: "reviews only apply to proposed (trace-foundry) benchmarks" },
      { status: 400 },
    );
  }
  if (entry.readOnly) {
    return NextResponse.json(
      { error: "This entry is read-only (demo/fixture source); reviews cannot be written here." },
      { status: 403 },
    );
  }
  if (!REVIEW_DECISIONS.includes(body.decision as ReviewDecision)) {
    return NextResponse.json(
      { error: `decision must be one of ${REVIEW_DECISIONS.join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof body.note === "string" && body.note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json({ error: `note too long (max ${MAX_NOTE_LENGTH} characters)` }, { status: 413 });
  }
  if (typeof body.task_id !== "string" || !entry.tasks.some((t) => t.task_id === body.task_id)) {
    return NextResponse.json({ error: "unknown task_id" }, { status: 404 });
  }

  const review = makeBenchmarkReview({
    // The foundry output dir slug (directory basename), not a benchmark.v1 id.
    benchmark_id: path.basename(entry.dir),
    task_id: body.task_id,
    decision: body.decision as ReviewDecision,
    note: body.note,
  });
  fs.appendFileSync(path.join(entry.dir, "reviews.jsonl"), serializeReviewLine(review), "utf8");
  return NextResponse.json({ ok: true, review });
}
