// Stage-2 scan results (data/scan.sqlite), read via node:sqlite — the Next dev
// server runs under Node 22, NOT bun, so bun:sqlite is off the table here.
// The scan is filling the table progressively; clusters/cluster_map may not
// exist yet (a later script creates them). Everything degrades gracefully.

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ScanRow = {
  session_id: string;
  label: string | null;
  summary: string | null;
  clusterId: number | null;
  cluster: string | null;
};

const DB_PATH = path.join(process.cwd(), "data", "scan.sqlite");

export function withScanDb<T>(fn: (db: DatabaseSync) => T): T | null {
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

// session_id → scan row (labels + cluster names when the cluster tables exist)
export function readScanMap(): Map<string, ScanRow> {
  const map = new Map<string, ScanRow>();
  withScanDb((db) => {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db
        .prepare(
          `SELECT s.session_id, s.label, s.summary,
                  m.cluster_id AS cluster_id, c.name AS cluster_name
           FROM session_scan s
           LEFT JOIN cluster_map m ON m.label = s.label
           LEFT JOIN clusters c ON c.id = m.cluster_id`,
        )
        .all() as Array<Record<string, unknown>>;
    } catch {
      // cluster tables absent — raw labels only
      rows = db
        .prepare(`SELECT session_id, label, summary FROM session_scan`)
        .all() as Array<Record<string, unknown>>;
    }
    for (const r of rows) {
      map.set(String(r.session_id), {
        session_id: String(r.session_id),
        label: (r.label as string | null) ?? null,
        summary: (r.summary as string | null) ?? null,
        clusterId: r.cluster_id == null ? null : Number(r.cluster_id),
        cluster: (r.cluster_name as string | null) ?? null,
      });
    }
    return null;
  });
  return map;
}

// case-insensitive substring match over label + summary
export function searchScan(q: string): Array<{ session_id: string; label: string | null; summary: string | null }> {
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return (
    withScanDb((db) =>
      db
        .prepare(
          `SELECT session_id, label, summary FROM session_scan
           WHERE label LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'`,
        )
        .all(pat, pat) as Array<{ session_id: string; label: string | null; summary: string | null }>,
    ) ?? []
  );
}
