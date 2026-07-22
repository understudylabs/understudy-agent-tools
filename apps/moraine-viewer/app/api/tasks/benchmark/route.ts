// GET /api/tasks/benchmark?cluster=<id> — serve a personal benchmark draft
// written by scripts/benchmark.ts (data/benchmarks/<cluster-slug>.json).
// Graceful { exists: false } 404 when the draft hasn't been built yet.

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NextRequest } from "next/server";
import { readBenchmarkDraft } from "../benchmarkFile";

export async function GET(request: NextRequest) {
  const idRaw = request.nextUrl.searchParams.get("cluster");
  const id = Number(idRaw);
  if (idRaw == null || !Number.isInteger(id) || id < 0) {
    return Response.json({ exists: false, error: "bad cluster id" }, { status: 400 });
  }

  const scanPath = path.join(process.cwd(), "data", "scan.sqlite");
  if (!existsSync(scanPath)) {
    return Response.json({ exists: false }, { status: 404 });
  }
  let name: string | null = null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(scanPath, { readOnly: true });
    const rows = db.prepare("SELECT name FROM clusters WHERE id = ?").all(id) as Array<{
      name: string;
    }>;
    name = rows[0]?.name ?? null;
  } catch {
    name = null;
  } finally {
    db?.close();
  }
  if (!name) return Response.json({ exists: false }, { status: 404 });

  const draft = readBenchmarkDraft(name);
  if (!draft) return Response.json({ exists: false }, { status: 404 });
  return Response.json({ exists: true, draft });
}
