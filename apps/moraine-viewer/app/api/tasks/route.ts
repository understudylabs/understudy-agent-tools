// GET /api/tasks — the Stage-4 precursor: clusters as benchmark candidates.
// Joins scan.sqlite (clusters/labels), commits.sqlite (commit↔session),
// langs.sqlite (languages/tools) and ClickHouse (token sums). Every sqlite
// source degrades gracefully when missing; ClickHouse failure → tokens 0.

import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { chQuery } from "@/lib/clickhouse";

// Loaded at runtime: a static `import { DatabaseSync } from "node:sqlite"`
// trips the dev bundler's external-module loader ("require is not defined").
const { DatabaseSync: SqliteDatabase } = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");
import { readBenchmarkDraft, readEvalFile, readEvalFiles } from "./benchmarkFile";

const PLUMBING = "cli plumbing";

function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T | null {
  const p = path.join(process.cwd(), "data", file);
  if (!existsSync(p)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new SqliteDatabase(p, { readOnly: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

type ScanRow = {
  session_id: string;
  events: number;
  label: string | null;
  summary: string | null;
  interactive: number;
  cluster_id: number | null;
  cluster_name: string | null;
};

export type TaskExemplar = {
  session_id: string;
  label: string | null;
  summary: string | null;
  events: number;
};

export type TaskCluster = {
  id: number;
  name: string;
  sessions: number;
  interactiveSessions: number;
  totalEvents: number;
  totalTokens: number;
  commits: number;
  topLanguages: Array<{ lang: string; files: number }>;
  topTools: Array<{ tool: string; uses: number }>;
  topLabels: Array<{ label: string; n: number }>;
  exemplars: TaskExemplar[];
  benchmark: { exists: boolean; instances: number; meanQuality: number } | null;
  /** legacy single eval — the local-gemma entry, kept for back-compat */
  eval: { candidate: string; mean: number; n: number; kind: string } | null;
  /** all real measured evals (scripts/evalrun.ts multi-model sweep) */
  evals: Array<{ candidate: string; mean: number; n: number; kind: string; judge: string }>;
};

export async function GET() {
  // scan: session → cluster + label + events + interactivity
  const scanRows =
    withDb("scan.sqlite", (db) =>
      db
        .prepare(
          `SELECT s.session_id, COALESCE(s.events, 0) AS events, s.label, s.summary,
                  COALESCE(s.interactive, 1) AS interactive,
                  m.cluster_id AS cluster_id, c.name AS cluster_name
           FROM session_scan s
           LEFT JOIN cluster_map m ON m.label = s.label
           LEFT JOIN clusters c ON c.id = m.cluster_id`,
        )
        .all(),
    ) as ScanRow[] | null;

  if (!scanRows) {
    return Response.json({ clusters: [], plumbing: null });
  }

  // commits: session → distinct commit hashes
  const commitMap = new Map<string, string[]>();
  withDb("commits.sqlite", (db) => {
    const rows = db.prepare(`SELECT hash, session_id FROM commit_sessions`).all() as Array<{
      hash: string;
      session_id: string;
    }>;
    for (const r of rows) {
      const list = commitMap.get(r.session_id);
      if (list) list.push(r.hash);
      else commitMap.set(r.session_id, [r.hash]);
    }
    return null;
  });

  // languages + tools per session
  const langMap = new Map<string, Array<{ lang: string; files: number }>>();
  const toolMap = new Map<string, Array<{ tool: string; uses: number }>>();
  withDb("langs.sqlite", (db) => {
    const langs = db.prepare(`SELECT session_id, lang, files FROM session_langs`).all() as Array<{
      session_id: string;
      lang: string;
      files: number;
    }>;
    for (const r of langs) {
      const list = langMap.get(r.session_id) ?? [];
      list.push({ lang: r.lang, files: Number(r.files) });
      langMap.set(r.session_id, list);
    }
    const tools = db.prepare(`SELECT session_id, tool, uses FROM session_tools`).all() as Array<{
      session_id: string;
      tool: string;
      uses: number;
    }>;
    for (const r of tools) {
      const list = toolMap.get(r.session_id) ?? [];
      list.push({ tool: r.tool, uses: Number(r.uses) });
      toolMap.set(r.session_id, list);
    }
    return null;
  });

  // token sums per session (UInt64 arrives as string; alias ≠ column names)
  const tokenMap = new Map<string, number>();
  try {
    const rows = await chQuery<{ sid: string; tok: string }>(
      `SELECT session_id AS sid,
              toString(sum(input_tokens) + sum(output_tokens) + sum(cache_read_tokens) + sum(cache_write_tokens)) AS tok
       FROM events WHERE event_ts > '2026-01-01' GROUP BY session_id`,
    );
    for (const r of rows) tokenMap.set(r.sid, Number(r.tok));
  } catch {
    // ClickHouse down — token totals stay 0
  }

  // group by cluster
  type Agg = {
    id: number;
    name: string;
    rows: ScanRow[];
  };
  const byCluster = new Map<number, Agg>();
  let plumbingSessions = 0;
  for (const r of scanRows) {
    if (r.cluster_id == null || !r.cluster_name) continue;
    if (r.cluster_name === PLUMBING) {
      plumbingSessions++;
      continue;
    }
    const agg = byCluster.get(r.cluster_id) ?? { id: Number(r.cluster_id), name: r.cluster_name, rows: [] };
    agg.rows.push(r);
    byCluster.set(Number(r.cluster_id), agg);
  }

  const clusters: TaskCluster[] = [...byCluster.values()]
    .map((agg) => {
      const langs = new Map<string, number>();
      const tools = new Map<string, number>();
      const labels = new Map<string, number>();
      let totalEvents = 0;
      let totalTokens = 0;
      let interactiveSessions = 0;
      const commitHashes = new Set<string>();
      for (const r of agg.rows) {
        totalEvents += Number(r.events);
        totalTokens += tokenMap.get(r.session_id) ?? 0;
        if (Number(r.interactive)) interactiveSessions++;
        if (r.label) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
        for (const h of commitMap.get(r.session_id) ?? []) commitHashes.add(h);
        for (const l of langMap.get(r.session_id) ?? []) langs.set(l.lang, (langs.get(l.lang) ?? 0) + l.files);
        for (const t of toolMap.get(r.session_id) ?? []) tools.set(t.tool, (tools.get(t.tool) ?? 0) + t.uses);
      }
      const exemplars: TaskExemplar[] = agg.rows
        .filter((r) => Number(r.interactive))
        .sort((a, b) => Number(b.events) - Number(a.events))
        .slice(0, 3)
        .map((r) => ({
          session_id: r.session_id,
          label: r.label,
          summary: r.summary ? r.summary.slice(0, 200) : null,
          events: Number(r.events),
        }));
      return {
        id: agg.id,
        name: agg.name,
        sessions: agg.rows.length,
        interactiveSessions,
        totalEvents,
        totalTokens,
        commits: commitHashes.size,
        topLanguages: [...langs.entries()]
          .map(([lang, files]) => ({ lang, files }))
          .sort((a, b) => b.files - a.files || a.lang.localeCompare(b.lang))
          .slice(0, 3),
        topTools: [...tools.entries()]
          .map(([tool, uses]) => ({ tool, uses }))
          .sort((a, b) => b.uses - a.uses || a.tool.localeCompare(b.tool))
          .slice(0, 5),
        topLabels: [...labels.entries()]
          .map(([label, n]) => ({ label, n }))
          .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
          .slice(0, 5),
        exemplars,
        benchmark: (() => {
          const draft = readBenchmarkDraft(agg.name);
          return draft
            ? {
                exists: true,
                instances: draft.counts.instances,
                meanQuality: draft.mean_quality,
              }
            : null;
        })(),
        eval: (() => {
          const e = readEvalFile(agg.name);
          return e ? { candidate: e.candidate, mean: e.mean, n: e.n, kind: e.kind } : null;
        })(),
        evals: readEvalFiles(agg.name).map((e) => ({
          candidate: e.candidate,
          mean: e.mean,
          n: e.n,
          kind: e.kind,
          judge: e.judge,
        })),
      };
    })
    .sort((a, b) => b.interactiveSessions - a.interactiveSessions || b.sessions - a.sessions);

  return Response.json({
    clusters,
    plumbing: {
      sessions: plumbingSessions,
      note: "non-interactive cli plumbing — excluded from benchmark candidacy",
    },
  });
}
