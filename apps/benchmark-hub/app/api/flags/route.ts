import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getEntry } from "@/lib/data";
import { FLAG_REASONS, type BenchmarkFlag, type FlagReason } from "@/lib/types";

export const dynamic = "force-dynamic";

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

  const entry = body.slug ? getEntry(body.slug) : null;
  if (!entry) return NextResponse.json({ error: "unknown benchmark" }, { status: 404 });
  if (entry.readOnly) {
    return NextResponse.json(
      { error: "This entry is a read-only demo (repo fixture); flags cannot be written here." },
      { status: 403 },
    );
  }
  if (!FLAG_REASONS.includes(body.reason as FlagReason)) {
    return NextResponse.json({ error: `reason must be one of ${FLAG_REASONS.join(", ")}` }, { status: 400 });
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
