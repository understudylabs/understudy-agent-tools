// Git-commit layer (data/commits.sqlite, written by scripts/commits.ts).
// Read via node:sqlite — the Next dev server runs under Node 22, not bun.
//
// GET /api/timeline/commits            → { days: [{d, c}], total, mapped }
// GET /api/timeline/commits?day=YYYY-MM-DD → { commits: [{hash7, repo, subject, ts, sessions}] }

import type { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = path.join(process.cwd(), "data", "commits.sqlite");

function withDb<T>(fn: (db: DatabaseSync) => T): T | null {
  if (!existsSync(DB_PATH)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function GET(request: NextRequest) {
  const day = request.nextUrl.searchParams.get("day");

  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return Response.json({ commits: [] });
    }
    const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
    const end = start + 86400;
    const commits =
      withDb((db) => {
        const rows = db
          .prepare(
            `SELECT c.hash, c.repo, c.subject, c.ts,
                    COALESCE(GROUP_CONCAT(cs.session_id, ''), '') AS sess
             FROM commits c
             LEFT JOIN commit_sessions cs ON cs.hash = c.hash
             WHERE c.ts >= ? AND c.ts < ?
             GROUP BY c.hash
             ORDER BY c.ts ASC`,
          )
          .all(start, end) as Array<{ hash: string; repo: string; subject: string; ts: number; sess: string }>;
        return rows.map((r) => ({
          hash7: r.hash.slice(0, 7),
          repo: path.basename(r.repo),
          subject: r.subject,
          ts: Number(r.ts),
          sessions: r.sess ? r.sess.split("") : [],
        }));
      }) ?? [];
    return Response.json({ commits });
  }

  const payload = withDb((db) => {
    const days = (
      db
        .prepare(
          `SELECT date(ts, 'unixepoch') AS d, COUNT(*) AS c
           FROM commits GROUP BY d ORDER BY d ASC`,
        )
        .all() as Array<{ d: string; c: number }>
    ).map((r) => ({ d: String(r.d), c: Number(r.c) }));
    const total = Number((db.prepare("SELECT COUNT(*) AS c FROM commits").all()[0] as { c: number }).c);
    const mapped = Number(
      (db.prepare("SELECT COUNT(DISTINCT hash) AS c FROM commit_sessions").all()[0] as { c: number }).c,
    );
    return { days, total, mapped };
  });
  return Response.json(payload ?? { days: [], total: 0, mapped: 0 });
}
