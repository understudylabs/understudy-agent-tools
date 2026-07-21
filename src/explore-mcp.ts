// `understudy explore mcp` — stdio MCP server that replaces Moraine's MCP for
// coding agents: same tool names/shapes (search_sessions, open, list_sessions,
// file_attention), reading local Moraine ClickHouse (read-only, capped) plus
// the Understudy scan stores under ~/.understudy/explore/, with two
// Understudy-native extras (explore_tasks, explore_status).
//
// All stdout is MCP protocol; diagnostics go to stderr only.

import { existsSync } from "node:fs";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ch, clickhouseUrl, countIn, exploreDir } from "./commands/explore.js";

// --- helpers ---------------------------------------------------------------------

function sqlq(s: string): string {
  // string literal escaping for ClickHouse
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const EVENT_TYPES = [
  "user_input", "assistant_response", "reasoning", "tool_call",
  "tool_response", "compaction", "system", "runtime",
] as const;

// same text-extraction fallback chain the explore scan digests use
const TEXT_EXPR = `multiIf(
  length(text_content) > 0, text_content,
  JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
  JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
  JSONExtractString(payload_json, 'input'))`;

function openScanDbRO(): DatabaseSync | null {
  const path = join(exploreDir(), "scan.sqlite");
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

type ScanInfo = { label: string; summary: string; cluster: string | null };

/** label/summary/cluster for a set of session ids; empty map when no scan store. */
function scanInfoFor(sessionIds: string[]): Map<string, ScanInfo> {
  const out = new Map<string, ScanInfo>();
  const db = openScanDbRO();
  if (!db || sessionIds.length === 0) {
    db?.close();
    return out;
  }
  try {
    const hasClusters =
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('clusters','cluster_map')").get() as { c: number }).c === 2;
    const placeholders = sessionIds.map(() => "?").join(",");
    const sql = hasClusters
      ? `SELECT s.session_id sid, s.label, s.summary, c.name cluster
         FROM session_scan s
         LEFT JOIN cluster_map m ON m.label = s.label
         LEFT JOIN clusters c ON c.id = m.cluster_id
         WHERE s.session_id IN (${placeholders})`
      : `SELECT session_id sid, label, summary, NULL cluster FROM session_scan WHERE session_id IN (${placeholders})`;
    for (const r of db.prepare(sql).all(...sessionIds) as { sid: string; label: string; summary: string; cluster: string | null }[]) {
      out.set(r.sid, { label: r.label, summary: r.summary, cluster: r.cluster ?? null });
    }
  } catch {
    /* scan store present but unreadable — return what we have */
  } finally {
    db.close();
  }
  return out;
}

interface SessionMeta {
  session_id: string;
  harness: string;
  source: string;
  mode: string;
  title: string;
  total_turns: number;
  total_events: number;
  user_messages: number;
  first_event_time: string;
  last_event_time: string;
  origin_cwd: string;
}

const SESSION_META_COLS = `session_id, harness, source, mode, title,
  toUInt32(total_turns) AS total_turns, toUInt32(total_events) AS total_events,
  toUInt32(user_messages) AS user_messages,
  toString(first_event_time) AS first_event_time, toString(last_event_time) AS last_event_time,
  origin_cwd`;

async function sessionMetaFor(sessionIds: string[]): Promise<Map<string, SessionMeta>> {
  const out = new Map<string, SessionMeta>();
  if (!sessionIds.length) return out;
  const inList = sessionIds.map((s) => `'${sqlq(s)}'`).join(",");
  for (const r of await ch<SessionMeta>(
    `SELECT ${SESSION_META_COLS} FROM mcp_open_sessions FINAL WHERE session_id IN (${inList})`,
  )) {
    out.set(r.session_id, r);
  }
  return out;
}

function enrich(meta: SessionMeta, scan: Map<string, ScanInfo>): Record<string, unknown> {
  const s = scan.get(meta.session_id);
  return {
    id: `session:${meta.session_id}`,
    session_id: meta.session_id,
    harness: meta.harness,
    source: meta.source,
    mode: meta.mode,
    title: meta.title || undefined,
    total_turns: meta.total_turns,
    total_events: meta.total_events,
    user_messages: meta.user_messages,
    first_event_time: meta.first_event_time,
    last_event_time: meta.last_event_time,
    origin_cwd: meta.origin_cwd || undefined,
    ...(s ? { label: s.label, summary: s.summary, cluster: s.cluster ?? undefined } : {}),
  };
}

// --- Moraine MCP proxy backend (bm25 search) ---------------------------------------

type MoraineClient = import("@modelcontextprotocol/sdk/client/index.js").Client;
let moraineClient: MoraineClient | null = null;
let moraineClientCloser: (() => Promise<void>) | null = null;

/** Lazily spawn `moraine run mcp` and connect as an MCP client. Reused across calls. */
async function getMoraineClient(): Promise<MoraineClient> {
  if (moraineClient) return moraineClient;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: "moraine",
    args: ["run", "mcp"],
    // child stderr must never leak into OUR stdout protocol stream
    stderr: "ignore",
  });
  const client = new Client({ name: "understudy-explore-proxy", version: "1.0.0" });
  await client.connect(transport);
  moraineClient = client;
  moraineClientCloser = async () => {
    try { await client.close(); } catch { /* already gone */ }
    moraineClient = null;
    moraineClientCloser = null;
  };
  return client;
}

export async function closeMoraineClient(): Promise<void> {
  await moraineClientCloser?.();
}

function extractSessionId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  for (const k of ["session_id", "sessionId", "id"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.replace(/^session:/, "");
  }
  return null;
}

/** First array of objects found in a parsed Moraine result (hits/sessions/results/root). */
function findHitArray(v: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(v)) {
    return v.every((x) => x && typeof x === "object") ? (v as Record<string, unknown>[]) : null;
  }
  if (v && typeof v === "object") {
    for (const key of ["hits", "sessions", "results", "matches"]) {
      const found = findHitArray((v as Record<string, unknown>)[key]);
      if (found) return found;
    }
    for (const val of Object.values(v)) {
      const found = findHitArray(val);
      if (found) return found;
    }
  }
  return null;
}

/** Forward search_sessions verbatim to Moraine's MCP (its BM25 index); enrich hits with scan fields. */
async function bm25Search(args: Record<string, unknown>): Promise<{ hits: Record<string, unknown>[]; raw?: string }> {
  const client = await getMoraineClient();
  const forward: Record<string, unknown> = {};
  for (const k of ["query", "n_hits", "event_types", "harness", "source", "within_id"]) {
    if (args[k] !== undefined) forward[k] = args[k];
  }
  const res = (await client.callTool({ name: "search_sessions", arguments: forward })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = (res.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n");
  if (res.isError) throw new Error(`moraine search_sessions failed: ${text.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Moraine 0.7.x returns prose with `(event:<base64-of-hex-uid>)` references:
    // decode them, resolve to sessions via ClickHouse, and enrich those.
    return { hits: await sessionsFromMoraineText(text), raw: text.slice(0, 6000) };
  }
  const hits = findHitArray(parsed) ?? [];
  const ids = hits.map(extractSessionId).filter((s): s is string => Boolean(s));
  const scan = scanInfoFor(ids);
  for (const h of hits) {
    const sid = extractSessionId(h);
    const s = sid ? scan.get(sid) : undefined;
    if (s) Object.assign(h, { label: s.label, summary: s.summary, cluster: s.cluster ?? undefined });
  }
  return { hits };
}

/** Resolve Moraine's text-form hits (event:<b64> refs) to enriched session records, order-preserving. */
async function sessionsFromMoraineText(text: string): Promise<Record<string, unknown>[]> {
  const uids: string[] = [];
  for (const m of text.matchAll(/event:([A-Za-z0-9+/=_-]{16,})/g)) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf8");
      if (/^[0-9a-f]{16,}$/.test(decoded) && !uids.includes(decoded)) uids.push(decoded);
    } catch { /* not base64 — skip */ }
  }
  if (!uids.length) return [];
  const inList = uids.map((u) => `'${sqlq(u)}'`).join(",");
  const rows = await ch<{ event_uid: string; session_id: string }>(
    `SELECT DISTINCT event_uid, session_id FROM mcp_open_events WHERE event_uid IN (${inList})`,
  );
  const sidByUid = new Map(rows.map((r) => [r.event_uid, r.session_id]));
  const sids: string[] = [];
  for (const u of uids) {
    const sid = sidByUid.get(u);
    if (sid && !sids.includes(sid)) sids.push(sid);
  }
  const meta = await sessionMetaFor(sids);
  const scan = scanInfoFor(sids);
  return sids.filter((s) => meta.has(s)).map((s) => enrich(meta.get(s)!, scan));
}

// --- tool implementations ----------------------------------------------------------

async function keywordSearchSessions(args: Record<string, unknown>): Promise<{ hits: Record<string, unknown>[] }> {
  const query = String(args.query ?? "").slice(0, 4096);
  if (!query.trim()) throw new Error("query is required");
  const nHits = Math.min(50, Math.max(1, Number(args.n_hits ?? 10)));
  const harness = args.harness ? String(args.harness) : null;
  const source = args.source ? String(args.source) : null;
  const withinId = args.within_id ? String(args.within_id).replace(/^session:/, "") : null;
  const eventTypes = Array.isArray(args.event_types)
    ? (args.event_types as string[]).filter((t) => (EVENT_TYPES as readonly string[]).includes(t))
    : [];

  // (a) scan.sqlite label/summary matches — ranked first
  const scanHits: { sid: string; via: string }[] = [];
  const sdb = openScanDbRO();
  if (sdb && !withinId) {
    try {
      const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const rows = sdb
        .prepare(
          `SELECT session_id sid, label, summary FROM session_scan
           WHERE (label LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
           ${harness ? "AND harness = ?" : ""}
           ORDER BY scanned_at DESC LIMIT ?`,
        )
        .all(...(harness ? [like, like, harness, nHits] : [like, like, nHits])) as { sid: string }[];
      for (const r of rows) scanHits.push({ sid: r.sid, via: "scan label/summary" });
    } catch {
      /* scan store unreadable — clickhouse leg still runs */
    } finally {
      sdb.close();
    }
  } else {
    sdb?.close();
  }

  // (b) ClickHouse keyword scan over event text (positionCaseInsensitive, not BM25)
  const where = [
    `positionCaseInsensitive(txt, '${sqlq(query)}') > 0`,
    eventTypes.length ? `event_type IN (${eventTypes.map((t) => `'${sqlq(t)}'`).join(",")})` : "",
    withinId ? `session_id = '${sqlq(withinId)}'` : "",
  ].filter(Boolean).join(" AND ");
  type ChHit = { session_id: string; matches: string; snippet: string };
  const chHits = await ch<ChHit>(`
    SELECT session_id, toString(count()) AS matches, substring(any(txt), 1, 300) AS snippet
    FROM (
      SELECT session_id, event_type, substring(${TEXT_EXPR}, 1, 2000) AS txt
      FROM mcp_open_events
      LIMIT 1 BY event_uid
    )
    WHERE ${where}
    GROUP BY session_id
    ORDER BY count() DESC
    LIMIT ${nHits * 3}
  `);

  const snippetBySid = new Map(chHits.map((h) => [h.session_id, h.snippet]));
  const matchesBySid = new Map(chHits.map((h) => [h.session_id, Number(h.matches)]));
  const orderedIds: string[] = [];
  for (const h of scanHits) if (!orderedIds.includes(h.sid)) orderedIds.push(h.sid);
  for (const h of chHits) if (!orderedIds.includes(h.session_id)) orderedIds.push(h.session_id);

  const meta = await sessionMetaFor(orderedIds);
  const scan = scanInfoFor(orderedIds);
  const scanHitSet = new Set(scanHits.map((h) => h.sid));
  const hits = orderedIds
    .filter((sid) => {
      const m = meta.get(sid);
      return Boolean(m) && (!harness || m!.harness === harness) && (!source || m!.source === source);
    })
    .map((sid) => ({
      ...enrich(meta.get(sid)!, scan),
      matched_via: scanHitSet.has(sid) ? "scan label/summary" : "event text",
      event_matches: matchesBySid.get(sid) ?? 0,
      snippet: snippetBySid.get(sid)?.replace(/\s+/g, " ").trim() || undefined,
    }))
    .slice(0, nHits);

  return { hits };
}

async function toolSearchSessions(args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? "").slice(0, 4096);
  if (!query.trim()) throw new Error("query is required");
  const nHits = Math.min(50, Math.max(1, Number(args.n_hits ?? 10)));
  const mode = ["bm25", "keyword", "both"].includes(String(args.mode)) ? String(args.mode) : "bm25";

  let bm25Hits: Record<string, unknown>[] | null = null;
  let bm25Raw: string | undefined;
  let bm25Error: string | undefined;
  if (mode === "bm25" || mode === "both") {
    try {
      const r = await bm25Search(args);
      bm25Hits = r.hits;
      bm25Raw = r.raw;
    } catch (e) {
      bm25Error = String(e instanceof Error ? e.message : e).slice(0, 300);
    }
  }

  if (mode === "bm25") {
    if (bm25Hits !== null) {
      return { query, mode_used: "bm25", n_hits: bm25Hits.length, hits: bm25Hits, ...(bm25Raw ? { raw: bm25Raw } : {}) };
    }
    // moraine missing or call failed — keyword fallback
    const kw = await keywordSearchSessions(args);
    return {
      query,
      mode_used: "keyword",
      fallback_reason: `bm25 backend unavailable: ${bm25Error ?? "unknown error"}`,
      n_hits: kw.hits.length,
      hits: kw.hits,
    };
  }

  const kw = await keywordSearchSessions(args);
  if (mode === "keyword") {
    return { query, mode_used: "keyword", n_hits: kw.hits.length, hits: kw.hits };
  }

  // both: bm25 rank first, keyword-only additions after, deduped by session id
  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const h of bm25Hits ?? []) {
    const sid = extractSessionId(h);
    if (sid) { if (seen.has(sid)) continue; seen.add(sid); }
    merged.push(h);
  }
  for (const h of kw.hits) {
    const sid = extractSessionId(h);
    if (sid && seen.has(sid)) continue;
    if (sid) seen.add(sid);
    merged.push(h);
  }
  return {
    query,
    mode_used: bm25Hits !== null ? "both" : "keyword",
    ...(bm25Error ? { bm25_error: bm25Error } : {}),
    n_hits: Math.min(merged.length, nHits * 2),
    hits: merged.slice(0, nHits * 2),
  };
}

async function toolOpen(args: Record<string, unknown>): Promise<unknown> {
  const rawId = String(args.id ?? "").trim();
  if (!rawId) throw new Error("id is required");
  if (/^(turn|event):/.test(rawId)) {
    throw new Error(
      `id form '${rawId.split(":")[0]}:' is not yet supported by understudy explore mcp v1 — ` +
        "use a session id (bare or 'session:<id>'), then page events with the cursor parameter.",
    );
  }
  const sessionId = rawId.replace(/^session:/, "");
  const cursor = Math.max(0, Number(args.cursor ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)));

  const meta = await sessionMetaFor([sessionId]);
  const m = meta.get(sessionId);
  if (!m) throw new Error(`session not found: ${sessionId}`);

  type Ev = {
    event_order: number; turn_seq: number; event_time: string; actor_role: string;
    event_type: string; name: string; t: string;
  };
  const events = await ch<Ev>(`
    SELECT toUInt32(event_order) AS event_order, toUInt32(turn_seq) AS turn_seq,
      toString(event_time) AS event_time, actor_role, event_type, name,
      substring(${TEXT_EXPR}, 1, 700) AS t
    FROM mcp_open_events
    WHERE session_id = '${sqlq(sessionId)}' AND event_order >= ${cursor}
    ORDER BY event_order ASC, slot DESC, generation DESC
    LIMIT 1 BY event_order
    LIMIT ${limit}
  `);
  const scan = scanInfoFor([sessionId]);
  const last = events.at(-1);
  return {
    session: enrich(m, scan),
    events: events.map((e) => ({
      event_order: e.event_order,
      turn: e.turn_seq,
      time: e.event_time,
      actor: e.actor_role,
      type: e.event_type,
      name: e.name || undefined,
      text: e.t.replace(/\s+/g, " ").trim() || undefined,
    })),
    next_cursor: events.length === limit && last ? last.event_order + 1 : null,
  };
}

async function toolListSessions(args: Record<string, unknown>): Promise<unknown> {
  const start = String(args.start_datetime ?? "");
  const end = String(args.end_datetime ?? "");
  if (!start || !end) throw new Error("start_datetime and end_datetime are required (RFC3339)");
  const limit = Math.min(25, Math.max(1, Number(args.limit ?? 20)));
  const sort = args.sort === "asc" ? "ASC" : "DESC";
  const offset = Math.max(0, Number(args.cursor ?? 0) || 0);
  const filters = [
    `last_event_time >= parseDateTime64BestEffort('${sqlq(start)}', 3)`,
    `first_event_time <= parseDateTime64BestEffort('${sqlq(end)}', 3)`,
    `first_event_time > toDateTime64('2001-01-01 00:00:00', 3)`,
    args.harness ? `harness = '${sqlq(String(args.harness))}'` : "",
    args.source ? `source = '${sqlq(String(args.source))}'` : "",
    args.mode ? `mode = '${sqlq(String(args.mode))}'` : "",
  ].filter(Boolean).join(" AND ");

  // filter/sort in a subquery: SESSION_META_COLS aliases toString(last_event_time)
  // AS last_event_time, and ClickHouse alias-shadowing would break the comparison
  const rows = await ch<SessionMeta>(`
    SELECT ${SESSION_META_COLS} FROM (
      SELECT * FROM mcp_open_sessions FINAL
      WHERE ${filters}
      ORDER BY last_event_time ${sort}
      LIMIT ${limit} OFFSET ${offset}
    )
    ORDER BY last_event_time ${sort} -- string sort; 'YYYY-MM-DD hh:mm:ss' is chronological
  `);
  const scan = scanInfoFor(rows.map((r) => r.session_id));
  return {
    sessions: rows.map((r) => enrich(r, scan)),
    next_cursor: rows.length === limit ? String(offset + limit) : null,
  };
}

const MUTATION_TOOLS = ["Edit", "Write", "edit", "write", "apply_patch", "NotebookEdit", "MultiEdit"];
const FILE_TOOLS = ["Read", "Edit", "Write", "read", "edit", "write", "apply_patch", "NotebookEdit", "MultiEdit", "Grep", "grep"];

async function toolFileAttention(args: Record<string, unknown>): Promise<unknown> {
  const path = String(args.path ?? "").trim();
  if (!path) throw new Error("path is required");
  const limit = Math.min(100, Math.max(1, Number(args.limit ?? 25)));
  const mutationsOnly = Boolean(args.mutations_only);
  const toolFilter = args.tool ? String(args.tool) : null;
  const tools = toolFilter ? [toolFilter] : mutationsOnly ? MUTATION_TOOLS : FILE_TOOLS;

  // path extraction: same structured payload shapes as explore.ts languages logic
  const pathExpr = `multiIf(
    JSONExtractString(payload_json,'input','file_path') != '', JSONExtractString(payload_json,'input','file_path'),
    JSONExtractString(payload_json,'input','filePath') != '', JSONExtractString(payload_json,'input','filePath'),
    JSONExtractString(payload_json,'state','input','filePath') != '', JSONExtractString(payload_json,'state','input','filePath'),
    JSONExtractString(payload_json,'file_path') != '', JSONExtractString(payload_json,'file_path'),
    JSONExtractString(payload_json,'path') != '', JSONExtractString(payload_json,'path'),
    repo_rel_path)`;
  const filters = [
    `tool_name IN (${tools.map((t) => `'${sqlq(t)}'`).join(",")})`,
    `is_substream = 0`,
    args.start_datetime
      ? `event_ts >= parseDateTime64BestEffort('${sqlq(String(args.start_datetime))}', 3)`
      : `event_ts > '2026-01-01'`,
    args.end_datetime ? `event_ts <= parseDateTime64BestEffort('${sqlq(String(args.end_datetime))}', 3)` : "",
    args.harness ? `harness = '${sqlq(String(args.harness))}'` : "",
    args.source ? `source_name = '${sqlq(String(args.source))}'` : "",
  ].filter(Boolean).join(" AND ");

  type Row = { session_id: string; touches: string; tools: string[]; first: string; last: string; sample_path: string };
  const rows = await ch<Row>(`
    SELECT session_id, toString(count()) AS touches, groupUniqArray(tool_name) AS tools,
      toString(min(event_ts)) AS first, toString(max(event_ts)) AS last,
      any(p) AS sample_path
    FROM (
      SELECT session_id, tool_name, event_ts, ${pathExpr} AS p
      FROM events
      WHERE ${filters}
    )
    WHERE p != '' AND (endsWith(p, '${sqlq(path)}') OR positionCaseInsensitive(p, '${sqlq(path)}') > 0)
    GROUP BY session_id
    ORDER BY count() DESC
    LIMIT ${limit}
  `);
  const scan = scanInfoFor(rows.map((r) => r.session_id));
  const meta = await sessionMetaFor(rows.map((r) => r.session_id));
  return {
    path,
    granularity: "sessions",
    note: "sessions granularity only in v1; matches structured tool payload paths (apply_patch inline file lists are not parsed)",
    sessions: rows.map((r) => ({
      ...(meta.has(r.session_id) ? enrich(meta.get(r.session_id)!, scan) : { session_id: r.session_id }),
      touches: Number(r.touches),
      tools: r.tools,
      first_touch: r.first,
      last_touch: r.last,
      sample_path: r.sample_path,
    })),
  };
}

function toolExploreTasks(): unknown {
  const db = openScanDbRO();
  if (!db) {
    return { has_scan: false, hint: "No scan store yet — suggest running `understudy explore scan` (then `understudy explore cluster`)." };
  }
  try {
    const scanned = (db.prepare("SELECT COUNT(*) c FROM session_scan").get() as { c: number }).c;
    const hasClusters =
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('clusters','cluster_map')").get() as { c: number }).c === 2;
    if (!hasClusters) {
      const top = db.prepare("SELECT label, COUNT(*) sessions FROM session_scan GROUP BY label ORDER BY sessions DESC LIMIT 20").all();
      return { has_scan: true, sessions_scanned: scanned, clusters: null, top_labels: top, hint: "Run `understudy explore cluster` to build the cluster catalog." };
    }
    const clusters = db
      .prepare(`
        SELECT c.name, COUNT(s.session_id) sessions,
          SUM(CASE WHEN s.label LIKE '%eval%' OR s.summary LIKE '%eval%'
                 OR s.label LIKE '%benchmark%' OR s.summary LIKE '%benchmark%' THEN 1 ELSE 0 END) eval_or_benchmark_sessions,
          GROUP_CONCAT(DISTINCT s.label) labels
        FROM session_scan s
        JOIN cluster_map m ON m.label = s.label
        JOIN clusters c ON c.id = m.cluster_id
        GROUP BY c.id ORDER BY sessions DESC
      `)
      .all() as { name: string; sessions: number; eval_or_benchmark_sessions: number; labels: string }[];
    return {
      has_scan: true,
      sessions_scanned: scanned,
      clusters: clusters.map((c) => ({
        name: c.name,
        sessions: c.sessions,
        eval_or_benchmark_sessions: c.eval_or_benchmark_sessions,
        sample_labels: c.labels.split(",").slice(0, 8),
      })),
    };
  } finally {
    db.close();
  }
}

async function toolExploreStatus(): Promise<unknown> {
  let chOk = false;
  try {
    chOk = (await ch<{ one: number }>("SELECT 1 AS one")).length === 1;
  } catch { /* unreachable */ }
  const scanned = countIn("scan.sqlite", "SELECT COUNT(*) c FROM session_scan");
  return {
    explore_dir: exploreDir(),
    clickhouse_url: clickhouseUrl(),
    clickhouse_reachable: chOk,
    has_scan: (scanned ?? 0) > 0,
    sessions_scanned: scanned,
    clusters: countIn("scan.sqlite", "SELECT COUNT(*) c FROM clusters"),
    commits: countIn("commits.sqlite", "SELECT COUNT(*) c FROM commits"),
    sessions_with_languages: countIn("langs.sqlite", "SELECT COUNT(DISTINCT session_id) c FROM session_langs"),
    hint:
      (scanned ?? 0) > 0
        ? undefined
        : "No scan data — suggest the user run `understudy explore scan` to enable label/summary/cluster enrichment.",
  };
}

// --- MCP server -------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_sessions",
    description:
      "Search local coding-agent session history. mode: bm25 = Moraine's full-text index (default, " +
      "proxied to `moraine run mcp`); keyword = substring scan over event text + Gemma scan " +
      "labels/summaries (labels ranked first); both = merged, bm25 rank first. All modes enrich hits " +
      "with Understudy scan label/summary/cluster where available; the result's mode_used reports any " +
      "fallback (e.g. bm25 backend unavailable → keyword).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 4096, description: "Search terms." },
        n_hits: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        mode: { type: "string", enum: ["bm25", "keyword", "both"], default: "bm25" },
        event_types: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] } },
        harness: { type: "string", description: "e.g. codex, claude-code, opencode, cursor" },
        source: { type: "string" },
        within_id: { type: "string", description: "Restrict search to one session id." },
      },
      required: ["query"],
    },
  },
  {
    name: "open",
    description:
      "Open a session: metadata + scan label/summary/cluster + a page of events (text truncated). " +
      "Accepts bare session ids or 'session:<id>'. 'turn:<n>' / 'event:<uid>' forms are not yet supported. " +
      "Page with cursor (= next_cursor from the previous call).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session id ('session:<id>' or bare)." },
        cursor: { type: "integer", minimum: 0, description: "event_order to start from." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["id"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List sessions in a time window, newest first by default, enriched with scan labels. " +
      "Cursor is an opaque offset string from next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        start_datetime: { type: "string", description: "RFC3339 window start (required)." },
        end_datetime: { type: "string", description: "RFC3339 window end (required)." },
        harness: { type: "string" },
        source: { type: "string" },
        mode: { type: "string", description: "e.g. chat, tool_calling, web_search" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 20 },
        sort: { type: "string", enum: ["asc", "desc"], default: "desc" },
        cursor: { type: "string" },
      },
      required: ["start_datetime", "end_datetime"],
    },
  },
  {
    name: "file_attention",
    description:
      "Which sessions touched a file path (suffix/substring match on structured tool-call payload paths). " +
      "v1 supports sessions granularity only; apply_patch inline file lists are not parsed, so codex patch " +
      "coverage is partial.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path or path tail, e.g. src/commands/explore.ts" },
        granularity: { type: "string", enum: ["sessions", "events"], default: "sessions", description: "'events' falls back to sessions in v1." },
        mutations_only: { type: "boolean", default: false, description: "Only Edit/Write/apply_patch-style tools." },
        tool: { type: "string", description: "Restrict to one tool name." },
        harness: { type: "string" },
        source: { type: "string" },
        start_datetime: { type: "string", description: "RFC3339; defaults to 2026-01-01." },
        end_datetime: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
      required: ["path"],
    },
  },
  {
    name: "explore_tasks",
    description:
      "Understudy-native: the cluster catalog of what the user actually works on — clusters with session " +
      "counts, sample labels, and how many sessions mention evals/benchmarks. Built from scan.sqlite; " +
      "if empty, suggest `understudy explore scan`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explore_status",
    description:
      "Understudy-native: data availability — ClickHouse reachability, scan/cluster/commit/language store " +
      "counts. If has_scan is false, suggest the user run `understudy explore scan`.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export async function runExploreMcpServer(): Promise<void> {
  const server = new Server(
    { name: "understudy-explore", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((t) => ({ ...t })) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      let result: unknown;
      switch (name) {
        case "search_sessions": result = await toolSearchSessions(args); break;
        case "open": result = await toolOpen(args); break;
        case "list_sessions": result = await toolListSessions(args); break;
        case "file_attention": result = await toolFileAttention(args); break;
        case "explore_tasks": result = toolExploreTasks(); break;
        case "explore_status": result = await toolExploreStatus(); break;
        default: throw new Error(`unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }], isError: true };
    }
  });

  server.onclose = () => { void closeMoraineClient(); };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { void closeMoraineClient().finally(() => process.exit(0)); });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`understudy explore mcp: serving ${TOOLS.length} tools over stdio (clickhouse ${clickhouseUrl()})`);
}

// --- registration takeover ----------------------------------------------------------

export async function runExploreMcpInstall(opts: { dryRun: boolean }): Promise<void> {
  const configPath = join(homedir(), ".claude.json");
  const serverEntry = { type: "stdio", command: "understudy", args: ["explore", "mcp"], env: {} };

  if (!existsSync(configPath)) {
    console.log(`claude-code: ${configPath} not found — nothing to install into.`);
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    console.error(`claude-code: could not parse ${configPath}: ${String(e).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const hadMoraine = "moraine" in servers;
  const changes: string[] = [];
  if (hadMoraine) changes.push("remove mcpServers.moraine (replaced)");
  changes.push(`set mcpServers.understudy = ${JSON.stringify(serverEntry)}`);

  console.log(`claude-code (${configPath}):`);
  for (const c of changes) console.log(`  - ${c}`);

  if (opts.dryRun) {
    console.log("dry run — no files written.");
    return;
  }

  const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(configPath, backup);
  delete servers.moraine;
  servers.understudy = serverEntry;
  config.mcpServers = servers;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`backup: ${backup}`);
  console.log("done — restart Claude Code (or /mcp reconnect) to pick up the `understudy` server.");
}
