import fs from "node:fs";
import { NextResponse } from "next/server";
// Relative imports (not "@/…") so the node:test harness can compile and load
// this route handler directly; data-core is the server-only-free loader.
import { captureFilePath, getEntry } from "../../../lib/data-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/captures?slug=<hub slug>&id=<capture_id> →
 * one normalized capture body from the proposed entry's on-disk store
 * (viewer/data/captures/*.json). The file name is recomputed from the
 * entry's capture index — the same slug guards as getEntry apply and no
 * client-supplied path ever reaches the filesystem. Capture bodies are only
 * ever served through here (lazy), never embedded in an RSC payload.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const id = url.searchParams.get("id");
  if (!slug || !id) {
    return NextResponse.json({ error: "slug and id query params are required" }, { status: 400 });
  }
  const entry = getEntry(slug);
  if (!entry || entry.kind !== "proposed") {
    return NextResponse.json({ error: "unknown proposed benchmark" }, { status: 404 });
  }
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
