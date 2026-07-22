import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { getEntry } from "../../../lib/data-core";
import { FLAG_REASONS, type BenchmarkFlag, type FlagReason } from "../../../lib/types";

export const dynamic = "force-dynamic";

/** Hard cap on flag note length (413 above this). */
const MAX_NOTE_LENGTH = 2000;

/**
 * POST { slug, task_id: string|null, reason, note } →
 * appends one understudy.benchmark_flag.v1 line to flags.jsonl next to the
 * benchmark's manifest. Fixture-backed (read-only) entries are rejected.
 */
export async function POST(request: Request) {
  let body: { slug?: string; task_id?: string | null; reason?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // getEntry resolves the slug prefix to one scan root and reads only the
  // target directory — a flag POST never rescans every benchmark.
  const entry = body.slug ? getEntry(body.slug) : null;
  if (!entry || entry.kind === "invalid") {
    return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  }
  if (entry.kind === "proposed") {
    return NextResponse.json(
      { error: "flags apply to promoted benchmarks; use /api/reviews for proposed (trace-foundry) tasks" },
      { status: 400 },
    );
  }
  if (entry.readOnly) {
    return NextResponse.json(
      { error: "This entry is read-only (demo/fixture source); flags cannot be written here." },
      { status: 403 },
    );
  }
  if (!FLAG_REASONS.includes(body.reason as FlagReason)) {
    return NextResponse.json({ error: `reason must be one of ${FLAG_REASONS.join(", ")}` }, { status: 400 });
  }
  if (typeof body.note === "string" && body.note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      { error: `note too long (max ${MAX_NOTE_LENGTH} characters)` },
      { status: 413 },
    );
  }
  if (body.task_id !== undefined && body.task_id !== null && typeof body.task_id !== "string") {
    return NextResponse.json({ error: "task_id must be a string or null" }, { status: 400 });
  }
  const taskId = body.task_id ?? null;
  if (taskId !== null && !entry.manifest.tasks.some((t) => t.task_id === taskId)) {
    return NextResponse.json({ error: "unknown task_id" }, { status: 404 });
  }

  const flag: BenchmarkFlag = {
    schema_version: "understudy.benchmark_flag.v1",
    benchmark_id: entry.manifest.benchmark_id,
    task_id: taskId,
    reason: body.reason as FlagReason,
    note: typeof body.note === "string" ? body.note : "",
    created_at: new Date().toISOString(),
    status: "open",
  };
  fs.appendFileSync(path.join(entry.dir, "flags.jsonl"), JSON.stringify(flag) + "\n", "utf8");
  return NextResponse.json({ ok: true, flag });
}
