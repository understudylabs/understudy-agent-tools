// Language/tooling layer (data/langs.sqlite, written by scripts/languages.ts),
// read via node:sqlite — same graceful-when-missing pattern as scan-db.ts.

import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LangStat = { lang: string; files: number };
export type ToolStat = { tool: string; uses: number };

const DB_PATH = path.join(process.cwd(), "data", "langs.sqlite");

function withLangsDb<T>(fn: (db: DatabaseSync) => T): T | null {
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

// session_id → dominant language (highest file count; ties break alphabetically
// via the ORDER BY so the assignment is stable across requests)
export function readDominantLangMap(): Map<string, string> {
  const map = new Map<string, string>();
  withLangsDb((db) => {
    const rows = db
      .prepare(`SELECT session_id, lang FROM session_langs ORDER BY files DESC, lang ASC`)
      .all() as Array<{ session_id: string; lang: string }>;
    for (const r of rows) {
      if (!map.has(String(r.session_id))) map.set(String(r.session_id), String(r.lang));
    }
    return null;
  });
  return map;
}

export function readSessionLangs(sessionId: string, limit = 6): LangStat[] {
  return (
    withLangsDb(
      (db) =>
        db
          .prepare(
            `SELECT lang, files FROM session_langs WHERE session_id = ?
             ORDER BY files DESC, lang ASC LIMIT ?`,
          )
          .all(sessionId, limit) as unknown as LangStat[],
    ) ?? []
  );
}

export function readSessionTools(sessionId: string, limit = 8): ToolStat[] {
  return (
    withLangsDb(
      (db) =>
        db
          .prepare(
            `SELECT tool, uses FROM session_tools WHERE session_id = ?
             ORDER BY uses DESC, tool ASC LIMIT ?`,
          )
          .all(sessionId, limit) as unknown as ToolStat[],
    ) ?? []
  );
}

// dominant-language → session count, for building the language chips row
export function readLangSessionCounts(): Array<{ lang: string; sessions: number }> {
  const counts = new Map<string, number>();
  for (const lang of readDominantLangMap().values()) {
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([lang, sessions]) => ({ lang, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.lang.localeCompare(b.lang));
}
