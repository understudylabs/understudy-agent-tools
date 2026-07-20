"use client";

// Explore Data adapter — implements the frontend surface declared in
// app/lib/exploreContract.ts over the Tauri invoke commands
// (src-tauri/src/explore.rs). Ported from the moraine-viewer prototype's
// route handlers (app/api/timeline/*, app/api/session, app/api/anatomy/session),
// which carry the hard-won ClickHouse fixes:
//   - alias-shadowing avoidance (unix-time aliases differ from column names)
//   - `LIMIT 1 BY event_order` dedup over slot/generation DESC on mcp_open_events
//     (no FINAL on mcp_open_events — projection tables dedup this way)
//   - payload-json multiIf text fallback chain
//   - sentinel-date filters (first_event_time > '2001-01-01')
//   - server-computed "ago" via ClickHouse now() (event clocks can run ahead)

import { invoke } from "@tauri-apps/api/core";
import type {
  CommitsPayload,
  DayCommit,
  ExploreStatus,
  SearchPayload,
  TimelinePayload,
  TimelineSessionRow,
  TranscriptEventRow,
  TranscriptPage,
} from "./exploreContract";

// Full detail for one session (superset of TimelineSessionRow — the
// SessionDetailPayload shape of the contract, concretely).
export interface SessionDetail {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: number;
  total_events: number;
  tool_calls: number;
  session_summary: string;
  origin_cwd: string;
  start: number;
  end: number;
  label?: string;
  scan_summary?: string;
  cluster?: string;
  clusterId?: number;
  langs?: Array<{ lang: string; files: number }>;
  tools?: Array<{ tool: string; uses: number }>;
}

export interface TracePreviewEvent {
  event_order: number;
  turn_seq: number;
  event_type: string;
  name: string;
  preview: string;
}

// ---------------------------------------------------------------------------
// invoke plumbing

// Browser-only dev fallback (NEXT_PUBLIC_EXPLORE_DEV=1): talk straight to
// local ClickHouse so the pane can be visually verified under `next dev`
// without booting a second app instance against shared desktop state.
// SQLite layers have no browser path and degrade to empty. Never on in prod.
const DEV_FALLBACK =
  process.env.NEXT_PUBLIC_EXPLORE_DEV === "1" && process.env.NODE_ENV !== "production";

function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  // Tauri v2 always injects __TAURI_INTERNALS__; __TAURI__ only exists with
  // withGlobalTauri. Under plain `next dev` neither is present.
  return w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined;
}

function assertDesktop(): void {
  if (!isDesktop() && !DEV_FALLBACK) {
    throw new Error("explore requires the desktop app");
  }
}

// ClickHouse read (JSONEachRow lines → row objects)
async function ch<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertDesktop();
  let raw: string;
  if (!isDesktop() && DEV_FALLBACK) {
    const res = await fetch(
      "/ch-proxy?database=moraine&default_format=JSONEachRow&max_memory_usage=2000000000&max_threads=4&max_execution_time=30",
      { method: "POST", body: `${sql.trim().replace(/;+\s*$/, "")} FORMAT JSONEachRow` },
    );
    if (!res.ok) throw new Error(`clickhouse ${res.status}`);
    raw = await res.text();
  } else {
    raw = await invoke<string>("explore_clickhouse_query", { sql });
  }
  const text = raw.trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as T);
}

// SQLite read over ~/.understudy/explore/<db>.sqlite (missing file → [])
async function sq<T = Record<string, unknown>>(
  db: "scan" | "commits" | "langs",
  sql: string,
  params: string[] = [],
): Promise<T[]> {
  assertDesktop();
  if (!isDesktop() && DEV_FALLBACK) return []; // no browser path to sqlite
  const raw = await invoke<string>("explore_sqlite_query", { db, sql, params });
  return JSON.parse(raw) as T[];
}

function escCh(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// scan / langs side tables (ported from scan-db.ts / langs-db.ts)

type ScanRow = {
  session_id: string;
  label: string | null;
  summary: string | null;
  clusterId: number | null;
  cluster: string | null;
};

async function readScanMap(): Promise<Map<string, ScanRow>> {
  const map = new Map<string, ScanRow>();
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sq(
      "scan",
      `SELECT s.session_id, s.label, s.summary,
              m.cluster_id AS cluster_id, c.name AS cluster_name
       FROM session_scan s
       LEFT JOIN cluster_map m ON m.label = s.label
       LEFT JOIN clusters c ON c.id = m.cluster_id`,
    );
  } catch {
    // cluster tables absent (the scan fills in progressively) — raw labels only
    try {
      rows = await sq("scan", `SELECT session_id, label, summary FROM session_scan`);
    } catch {
      return map;
    }
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
  return map;
}

// session_id → dominant language (highest file count; ORDER BY keeps ties stable)
async function readDominantLangMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = await sq<{ session_id: string; lang: string }>(
      "langs",
      `SELECT session_id, lang FROM session_langs ORDER BY files DESC, lang ASC`,
    );
    for (const r of rows) {
      if (!map.has(String(r.session_id))) map.set(String(r.session_id), String(r.lang));
    }
  } catch {
    // langs.sqlite unreadable — language layer simply absent
  }
  return map;
}

async function readSessionLangs(sessionId: string, limit = 6) {
  try {
    return await sq<{ lang: string; files: number }>(
      "langs",
      `SELECT lang, files FROM session_langs WHERE session_id = ?
       ORDER BY files DESC, lang ASC LIMIT ?`,
      [sessionId, String(limit)],
    );
  } catch {
    return [];
  }
}

async function readSessionTools(sessionId: string, limit = 8) {
  try {
    return await sq<{ tool: string; uses: number }>(
      "langs",
      `SELECT tool, uses FROM session_tools WHERE session_id = ?
       ORDER BY uses DESC, tool ASC LIMIT ?`,
      [sessionId, String(limit)],
    );
  } catch {
    return [];
  }
}

async function searchScan(
  q: string,
): Promise<Array<{ session_id: string; label: string | null; summary: string | null }>> {
  const pat = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  try {
    return await sq(
      "scan",
      `SELECT session_id, label, summary FROM session_scan
       WHERE label LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'`,
      [pat, pat],
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// fetchTimeline — session list + scan labels/clusters + dominant lang + tokens

interface ChSessionRow {
  session_id: string;
  harness: string;
  mode: string;
  title: string;
  total_events: number;
  total_turns: number;
  start_s: string;
  end_s: string;
}

export async function fetchTimeline(): Promise<TimelinePayload> {
  const [rows, tokenRows, scanMap, langMap] = await Promise.all([
    // alias-shadowing gotcha: unix-time aliases (start_s/end_s) must DIFFER
    // from the column names or WHERE filters on those names break
    ch<ChSessionRow>(
      `SELECT session_id, harness, mode, title,
              toUInt32(total_events) AS total_events,
              toUInt32(total_turns) AS total_turns,
              toString(toUnixTimestamp(first_event_time)) AS start_s,
              toString(toUnixTimestamp(last_event_time)) AS end_s
       FROM mcp_open_sessions FINAL
       WHERE first_event_time > '2001-01-01'`,
    ),
    // bulk token totals (cost color mode) — UInt64 sums arrive as strings
    ch<{ sid: string; tok: string }>(
      `SELECT session_id AS sid,
              toString(sum(input_tokens) + sum(output_tokens) + sum(cache_read_tokens) + sum(cache_write_tokens)) AS tok
       FROM events WHERE event_ts > '2026-01-01' GROUP BY session_id`,
    ),
    readScanMap(),
    readDominantLangMap(),
  ]);
  const tokenMap = new Map(tokenRows.map((r) => [r.sid, Number(r.tok)]));

  const sessions: TimelineSessionRow[] = rows.map((r) => {
    const scan = scanMap.get(r.session_id);
    const lang = langMap.get(r.session_id);
    return {
      id: r.session_id,
      harness: r.harness || "unknown",
      mode: r.mode || "unknown",
      // Moraine only gets titles from opencode/cursor; the Gemma scan labeled
      // everything else — a far better name than "untitled session"
      title: r.title || scan?.label || "",
      events: r.total_events,
      turns: r.total_turns,
      start: Number(r.start_s),
      end: Number(r.end_s),
      tokens: tokenMap.get(r.session_id) ?? 0,
      ...(scan?.label ? { label: scan.label } : {}),
      ...(scan?.cluster ? { cluster: scan.cluster } : {}),
      ...(scan?.clusterId != null ? { clusterId: scan.clusterId } : {}),
      ...(lang ? { lang } : {}),
    };
  });

  const harnesses = [...new Set(sessions.map((s) => s.harness))].sort();
  return { sessions, meta: { count: sessions.length, harnesses } };
}

// ---------------------------------------------------------------------------
// fetchSessionDetail — one session incl. summary + scan + langs/tools

export async function fetchSessionDetail(id: string): Promise<SessionDetail | null> {
  const rows = await ch<{
    session_id: string;
    title: string;
    harness: string;
    mode: string;
    total_turns: number;
    total_events: number;
    tool_calls: number;
    session_summary: string;
    origin_cwd: string;
    start_s: string;
    end_s: string;
  }>(
    `SELECT session_id, title, harness, mode,
            toUInt32(total_turns) AS total_turns,
            toUInt32(total_events) AS total_events,
            toUInt32(tool_calls) AS tool_calls,
            session_summary, origin_cwd,
            toString(toUnixTimestamp(first_event_time)) AS start_s,
            toString(toUnixTimestamp(last_event_time)) AS end_s
     FROM mcp_open_sessions FINAL
     WHERE session_id = '${escCh(id)}'
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const [scanMap, langs, tools] = await Promise.all([
    readScanMap(),
    readSessionLangs(r.session_id, 6),
    readSessionTools(r.session_id, 8),
  ]);
  const scan = scanMap.get(r.session_id);
  return {
    ...(langs.length ? { langs } : {}),
    ...(tools.length ? { tools } : {}),
    ...(scan?.label ? { label: scan.label } : {}),
    ...(scan?.summary ? { scan_summary: scan.summary } : {}),
    ...(scan?.cluster ? { cluster: scan.cluster } : {}),
    ...(scan?.clusterId != null ? { clusterId: scan.clusterId } : {}),
    session_id: r.session_id,
    title: r.title || scan?.label || "",
    harness: r.harness,
    mode: r.mode,
    total_turns: r.total_turns,
    total_events: r.total_events,
    tool_calls: r.tool_calls,
    session_summary: r.session_summary,
    origin_cwd: r.origin_cwd,
    start: Number(r.start_s),
    end: Number(r.end_s),
  };
}

// ---------------------------------------------------------------------------
// searchTimeline — ClickHouse ILIKE over title/summary/cwd/slug + scan union

const SNIPPET_LEN = 140;

interface SearchRow {
  session_id: string;
  title: string;
  session_summary: string;
  origin_cwd: string;
  session_slug: string;
}

function snippetFor(row: SearchRow, q: string): { field: string; snippet: string } {
  const lower = q.toLowerCase();
  const fields: Array<[string, string]> = [
    ["title", row.title],
    ["session_summary", row.session_summary],
    ["origin_cwd", row.origin_cwd],
    ["session_slug", row.session_slug],
  ];
  for (const [field, value] of fields) {
    const idx = value.toLowerCase().indexOf(lower);
    if (idx < 0) continue;
    // center a ~140-char window on the first hit
    const from = Math.max(0, idx - Math.floor((SNIPPET_LEN - q.length) / 2));
    let snip = value.slice(from, from + SNIPPET_LEN).replace(/\s+/g, " ").trim();
    if (from > 0) snip = `…${snip}`;
    if (from + SNIPPET_LEN < value.length) snip = `${snip}…`;
    return { field, snippet: snip };
  }
  return { field: "title", snippet: (row.title || row.session_id).slice(0, SNIPPET_LEN) };
}

export async function searchTimeline(q: string): Promise<SearchPayload> {
  const query = q.trim();
  if (!query) return { q: "", count: 0, ids: [], results: [] };

  // escape for a single-quoted ILIKE pattern
  const escaped = escCh(query).replace(/%/g, "\\%").replace(/_/g, "\\_");
  const pat = `'%${escaped}%'`;

  const [rows, scanHits] = await Promise.all([
    ch<SearchRow>(
      `SELECT session_id, title,
              substring(session_summary, 1, 4000) AS session_summary,
              origin_cwd, session_slug
       FROM mcp_open_sessions FINAL
       WHERE first_event_time > '2001-01-01'
         AND (title ILIKE ${pat}
           OR session_summary ILIKE ${pat}
           OR origin_cwd ILIKE ${pat}
           OR session_slug ILIKE ${pat})`,
    ),
    searchScan(query),
  ]);

  const chIds = new Set(rows.map((r) => r.session_id));
  const ids = rows.map((r) => r.session_id);
  const results = rows.slice(0, 40).map((r) => ({ id: r.session_id, ...snippetFor(r, query) }));

  const lower = query.toLowerCase();
  for (const hit of scanHits) {
    if (chIds.has(hit.session_id)) continue;
    ids.push(hit.session_id);
    if (results.length >= 40) continue;
    const labelHit = (hit.label ?? "").toLowerCase().includes(lower);
    const src = labelHit ? (hit.label ?? "") : (hit.summary ?? "");
    results.push({
      id: hit.session_id,
      field: labelHit ? "label" : "scan",
      snippet: src.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LEN),
    });
  }

  return { q: query, count: ids.length, ids, results };
}

// ---------------------------------------------------------------------------
// fetchLive / fetchHealth — server-computed ago via ClickHouse now()

export async function fetchLive(): Promise<{ now: number; ids: string[] }> {
  // Query window is 150s; the 120s cut happens here against ClickHouse's own
  // now() (event clocks can run ahead of the server, so ahead counts as live).
  // Aliases (sid/last_s) must differ from column names — see alias gotcha.
  const [rows, nowRows] = await Promise.all([
    ch<{ sid: string; last_s: string }>(
      `SELECT session_id AS sid,
              toString(toUnixTimestamp(last_event_time)) AS last_s
       FROM mcp_open_sessions FINAL
       WHERE last_event_time > now() - INTERVAL 150 SECOND`,
    ),
    ch<{ n: string }>(`SELECT toString(toUnixTimestamp(now())) AS n`),
  ]);
  const now = Number(nowRows[0]?.n ?? Math.floor(Date.now() / 1000));
  const ids = rows.filter((r) => now - Number(r.last_s) <= 120).map((r) => r.sid);
  return { now, ids };
}

export async function fetchHealth(): Promise<{ lastEventAgoS: number; ingesting: boolean }> {
  // max() over an empty day comes back as unix 0 — treat as stale; clamp
  // negative ages (event clocks ahead of server) to 0
  const rows = await ch<{ m: string; n: string }>(
    `SELECT toString(toUnixTimestamp(max(event_ts))) AS m,
            toString(toUnixTimestamp(now())) AS n
     FROM events WHERE event_ts > now() - INTERVAL 1 DAY`,
  );
  const m = Number(rows[0]?.m ?? 0);
  const now = Number(rows[0]?.n ?? Math.floor(Date.now() / 1000));
  const lastEventAgoS = m > 0 ? Math.max(0, now - m) : 86400;
  return { lastEventAgoS, ingesting: lastEventAgoS < 300 };
}

// ---------------------------------------------------------------------------
// commits layer (commits.sqlite)

export async function fetchCommits(): Promise<CommitsPayload> {
  try {
    const [days, totals, mappedRows] = await Promise.all([
      sq<{ d: string; c: number }>(
        "commits",
        `SELECT date(ts, 'unixepoch') AS d, COUNT(*) AS c
         FROM commits GROUP BY d ORDER BY d ASC`,
      ),
      sq<{ c: number }>("commits", `SELECT COUNT(*) AS c FROM commits`),
      sq<{ c: number }>("commits", `SELECT COUNT(DISTINCT hash) AS c FROM commit_sessions`),
    ]);
    return {
      days: days.map((r) => ({ d: String(r.d), c: Number(r.c) })),
      total: Number(totals[0]?.c ?? 0),
      mapped: Number(mappedRows[0]?.c ?? 0),
    };
  } catch {
    return { days: [], total: 0, mapped: 0 };
  }
}

export async function fetchCommitsDay(day: string): Promise<{ commits: DayCommit[] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { commits: [] };
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  const end = start + 86400;
  try {
    // \x1f (unit separator) as the GROUP_CONCAT joiner — session ids never
    // contain it, unlike ',' which would also survive in some slugs
    const rows = await sq<{ hash: string; repo: string; subject: string; ts: number; sess: string }>(
      "commits",
      `SELECT c.hash, c.repo, c.subject, c.ts,
              COALESCE(GROUP_CONCAT(cs.session_id, '\x1f'), '') AS sess
       FROM commits c
       LEFT JOIN commit_sessions cs ON cs.hash = c.hash
       WHERE c.ts >= ? AND c.ts < ?
       GROUP BY c.hash
       ORDER BY c.ts ASC`,
      [String(start), String(end)],
    );
    return {
      commits: rows.map((r) => ({
        hash7: r.hash.slice(0, 7),
        repo: r.repo.split("/").filter(Boolean).pop() ?? r.repo,
        subject: r.subject,
        ts: Number(r.ts),
        sessions: r.sess ? r.sess.split("\x1f") : [],
      })),
    };
  } catch {
    return { commits: [] };
  }
}

// ---------------------------------------------------------------------------
// languages chips (dominant-language session counts)

export async function fetchLanguages(): Promise<{
  langs: Array<{ lang: string; sessions: number }>;
}> {
  const counts = new Map<string, number>();
  for (const lang of (await readDominantLangMap()).values()) {
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const langs = [...counts.entries()]
    .map(([lang, sessions]) => ({ lang, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.lang.localeCompare(b.lang));
  return { langs };
}

// ---------------------------------------------------------------------------
// fetchTranscript — full lossless transcript page (ported from /api/session)

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const TEXT_CAP = 20000;

// The established payload fallback: text_content, then payload_json
// .text / .content[0].text / .input / .output.
const FULL_TEXT_EXPR = `multiIf(
  length(text_content) > 0, text_content,
  JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
  JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
  JSONExtractString(payload_json, 'input') != '', JSONExtractString(payload_json, 'input'),
  JSONExtractString(payload_json, 'output')
)`;

interface RawTranscriptEvent extends TranscriptEventRow {
  event_uid: string;
}

export async function fetchTranscript(
  id: string,
  cursor = 0,
  limit = DEFAULT_LIMIT,
): Promise<TranscriptPage> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("bad session id");
  const cur = Math.max(0, Math.floor(cursor) || 0);
  const lim = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));

  const [sessions, rawEvents, models, tokenTotals, latestRows] = await Promise.all([
    ch<{
      session_id: string;
      title: string;
      harness: string;
      mode: string;
      total_turns: number;
      total_events: number;
      first_event_time: string;
      last_event_time: string;
    }>(`
      SELECT
        session_id, title, harness, mode,
        toUInt32(total_turns) AS total_turns,
        toUInt32(total_events) AS total_events,
        toString(first_event_time) AS first_event_time,
        toString(last_event_time) AS last_event_time
      FROM mcp_open_sessions FINAL
      WHERE session_id = '${id}'
      ORDER BY generation DESC
      LIMIT 1
    `),
    ch<RawTranscriptEvent>(`
      SELECT
        toUInt32(event_order) AS event_order,
        toUInt32(turn_seq) AS turn_seq,
        toString(event_time) AS event_time,
        actor_role, event_type, name, call_id,
        event_uid,
        substring(${FULL_TEXT_EXPR}, 1, ${TEXT_CAP}) AS text,
        toUInt8(length(${FULL_TEXT_EXPR}) > ${TEXT_CAP}) AS text_truncated,
        substring(payload_json, 1, ${TEXT_CAP}) AS payload_json,
        toUInt8(length(payload_json) > ${TEXT_CAP}) AS payload_truncated,
        toUInt32(arraySum(mapValues(token_usage_buckets))) AS tokens
      FROM mcp_open_events
      WHERE session_id = '${id}' AND event_order > ${cur}
      ORDER BY event_order ASC, slot DESC, generation DESC
      LIMIT 1 BY event_order
      LIMIT ${lim}
    `),
    ch<{ model: string }>(`
      SELECT DISTINCT model
      FROM events
      WHERE session_id = '${id}' AND model != ''
      LIMIT 12
    `),
    ch<{ total_tokens: string }>(`
      SELECT toString(sum(arraySum(mapValues(token_usage_buckets)))) AS total_tokens
      FROM (
        SELECT token_usage_buckets
        FROM mcp_open_events
        WHERE session_id = '${id}'
        ORDER BY event_order ASC, slot DESC, generation DESC
        LIMIT 1 BY event_order
      )
    `),
    // Cheap tail probe for live tailing: max event_order + last event time
    // currently in the projection.
    ch<{ latest_order: number; last_time: string; ago_s: string }>(`
      SELECT
        toUInt32(max(event_order)) AS latest_order,
        toString(max(event_time)) AS last_time,
        toInt64(now() - max(event_time)) AS ago_s
      FROM mcp_open_events
      WHERE session_id = '${id}'
    `),
  ]);

  if (!sessions.length) throw new Error("session not found");

  // Bulk substream join keyed by event_uid (alias outputs so they don't
  // shadow the filter columns).
  const uids = [
    ...new Set(rawEvents.map((e) => e.event_uid).filter((u) => /^[a-f0-9]{16,64}$/.test(u))),
  ];
  const subMap = new Map<string, { uid: string; sub: number; label: string; run: string }>();
  if (uids.length) {
    const rows = await ch<{ uid: string; sub: number; label: string; run: string }>(`
      SELECT
        event_uid AS uid,
        toUInt8(max(is_substream)) AS sub,
        anyLast(agent_label) AS label,
        anyLast(agent_run_id) AS run
      FROM events
      WHERE session_id = '${id}'
        AND event_uid IN (${uids.map((u) => `'${u}'`).join(",")})
      GROUP BY event_uid
    `);
    for (const r of rows) subMap.set(r.uid, r);
  }

  const events: TranscriptEventRow[] = rawEvents.map(({ event_uid, ...e }) => {
    const s = subMap.get(event_uid);
    return {
      ...e,
      is_substream: s?.sub ?? 0,
      agent_label: s?.label ?? "",
      agent_run_id: s?.run ?? "",
    };
  });

  const s = sessions[0];
  // Moraine titles only exist for opencode/cursor — fall back to the scan label
  let title = s.title;
  if (!title) {
    try {
      const scan = await sq<{ label: string }>(
        "scan",
        "SELECT label FROM session_scan WHERE session_id = ? LIMIT 1",
        [id],
      );
      title = scan[0]?.label ?? "";
    } catch { /* scan store absent */ }
  }
  return {
    session: {
      id: s.session_id,
      title,
      harness: s.harness,
      mode: s.mode,
      turns: s.total_turns,
      events: s.total_events,
      firstEventTime: s.first_event_time,
      lastEventTime: s.last_event_time,
      models: [...new Set(models.map((m) => normalizeModel(m.model)))],
      totalTokens: Number(tokenTotals[0]?.total_tokens ?? 0),
    },
    events,
    latestOrder: latestRows[0]?.latest_order ?? 0,
    lastEventTime: latestRows[0]?.last_time ?? s.last_event_time,
    lastEventAgoS: Math.max(0, Number(latestRows[0]?.ago_s ?? 86400)),
    nextCursor: events.length === lim ? events[events.length - 1].event_order : null,
  };
}

// ---------------------------------------------------------------------------
// fetchTracePreview — compact event list for the timeline side panel.
// Ported from /api/anatomy/session's event query (deduped, 1200-char preview)
// but capped at 400 rows instead of 2000: the preview shows ≤40 meaningful
// events, and the full trace lives one click away in the transcript pane.

const PREVIEW_MAX_EVENTS = 400;

export async function fetchTracePreview(id: string): Promise<TracePreviewEvent[]> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("bad session id");
  return ch<TracePreviewEvent>(`
    SELECT
      toUInt32(event_order) AS event_order,
      toUInt32(turn_seq) AS turn_seq,
      event_type, name,
      substring(
        multiIf(
          length(text_content) > 0, text_content,
          JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
          JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
          JSONExtractString(payload_json, 'input') != '', JSONExtractString(payload_json, 'input'),
          JSONExtractString(payload_json, 'output')
        ), 1, 1200
      ) AS preview
    FROM mcp_open_events
    WHERE session_id = '${id}'
    ORDER BY event_order ASC, slot DESC, generation DESC
    LIMIT 1 BY event_order
    LIMIT ${PREVIEW_MAX_EVENTS}
  `);
}

// ---------------------------------------------------------------------------
// status

export async function fetchExploreStatus(): Promise<ExploreStatus> {
  assertDesktop();
  if (!isDesktop() && DEV_FALLBACK) {
    let clickhouseUp = false;
    try {
      clickhouseUp = (await (await fetch("/ch-proxy?query=SELECT%201")).text()).trim() === "1";
    } catch { /* down */ }
    return { moraineUp: clickhouseUp, clickhouseUp, dataDir: "(dev fallback)", hasScan: false, hasCommits: false, hasLangs: false };
  }
  const raw = await invoke<string>("explore_status");
  return JSON.parse(raw) as ExploreStatus;
}

// ---------------------------------------------------------------------------
// `model` values are sometimes JSON blobs or filesystem paths — normalize.

export function normalizeModel(raw: string): string {
  if (!raw) return "unknown";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.modelid ?? parsed.model ?? raw;
    } catch {
      return raw;
    }
  }
  if (raw.includes("/")) return raw.split("/").filter(Boolean).pop() ?? raw;
  return raw;
}
