import fs from "node:fs";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { captureFilePath, getEntry } from "../../../lib/data-core";
import { captureRolloutMeta } from "../../../lib/trajectory-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/captures?slug=<hub slug>&id=<capture_id> →
 * one normalized capture body from the proposed entry's on-disk store
 * (viewer/data/captures/*.json). The file name is recomputed from the
 * entry's capture index — the same slug guards as getEntry apply and no
 * client-supplied path ever reaches the filesystem. Capture bodies are only
 * ever served through here (lazy), never embedded in an RSC payload.
 *
 * GET /api/captures?slug=<hub slug>&task=<task_id>&meta=1 →
 * light per-round metadata for the explorer's LEFT pane (snippet, turn/tool
 * counts, workload, trace id, sha256) for the task's captures in capture
 * order. Bodies are read server-side but only small derived fields leave the
 * process — full payloads still load one round at a time via the id mode.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const id = url.searchParams.get("id");
  const task = url.searchParams.get("task");
  const meta = url.searchParams.get("meta") === "1";
  if (!slug || (!id && !(task && meta))) {
    return NextResponse.json({ error: "slug plus either id or task&meta=1 query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind !== "proposed") {
    return NextResponse.json({ error: "unknown proposed benchmark" }, { status: 404 });
  }

  if (task && meta) {
    const t = entry.tasks.find((tk) => tk.task_id === task);
    if (!t) return NextResponse.json({ error: "unknown task id" }, { status: 404 });
    const rounds = (t.source?.captures ?? []).map((ref) => {
      const file = captureFilePath(entry, ref.capture_id);
      let body: Record<string, unknown> | null = null;
      try {
        if (file) body = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // body missing on disk — pointer-only round
      }
      const derived = body ? captureRolloutMeta(ref.capture_id, body) : null;
      return {
        capture_id: ref.capture_id,
        sha256: ref.sha256,
        pointer: ref.pointer,
        captured_at: derived?.capturedAt ?? null,
        snippet: derived?.snippet ?? "",
        message_count: derived?.messageCount ?? 0,
        tool_call_count: derived?.toolCallCount ?? 0,
        workload: derived?.workload ?? null,
        trace_id: derived?.traceId ?? null,
        body_missing: body === null,
      };
    });
    rounds.sort((a, b) => String(a.captured_at ?? "").localeCompare(String(b.captured_at ?? "")));
    return NextResponse.json({ task_id: task, rounds });
  }
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });
  const file = captureFilePath(entry, id);
  if (!file) {
    return NextResponse.json({ error: "unknown capture id" }, { status: 404 });
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return NextResponse.json({ error: "capture file missing on disk" }, { status: 404 });
  }
  return new NextResponse(text, { headers: { "content-type": "application/json" } });
}
