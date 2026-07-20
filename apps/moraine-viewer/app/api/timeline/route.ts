import type { NextRequest } from "next/server";
import { chQuery } from "@/lib/clickhouse";
import type { TimelineSession } from "@/components/timeline/types";
import { readScanMap } from "./scan-db";
import { readDominantLangMap, readSessionLangs, readSessionTools } from "./langs-db";

// GET /api/timeline            → { sessions, meta }  (all non-sentinel sessions)
// GET /api/timeline?session=id → { session }         (detail incl. session_summary)
//
// ClickHouse alias-shadowing gotcha: `toString(last_event_time) AS last_event_time`
// breaks WHERE filters on the same name — so the unix-time aliases DIFFER from the
// column names (start_s / end_s).

interface SessionRow {
  session_id: string;
  harness: string;
  mode: string;
  title: string;
  total_events: number;
  total_turns: number;
  start_s: string;
  end_s: string;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session");

  if (sessionId) {
    const rows = await chQuery<{
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
       WHERE session_id = '${sessionId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'
       LIMIT 1`,
    );
    if (rows.length === 0) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }
    const r = rows[0];
    const scan = readScanMap().get(r.session_id);
    const langs = readSessionLangs(r.session_id, 6);
    const tools = readSessionTools(r.session_id, 8);
    return Response.json({
      session: {
        ...(langs.length ? { langs } : {}),
        ...(tools.length ? { tools } : {}),
        ...(scan?.label ? { label: scan.label } : {}),
        ...(scan?.summary ? { scan_summary: scan.summary } : {}),
        ...(scan?.cluster ? { cluster: scan.cluster } : {}),
        ...(scan?.clusterId != null ? { clusterId: scan.clusterId } : {}),
        session_id: r.session_id,
        title: r.title,
        harness: r.harness,
        mode: r.mode,
        total_turns: r.total_turns,
        total_events: r.total_events,
        tool_calls: r.tool_calls,
        session_summary: r.session_summary,
        origin_cwd: r.origin_cwd,
        start: Number(r.start_s),
        end: Number(r.end_s),
      },
    });
  }

  const [rows, tokenRows] = await Promise.all([
    chQuery<SessionRow>(
      `SELECT session_id, harness, mode, title,
              toUInt32(total_events) AS total_events,
              toUInt32(total_turns) AS total_turns,
              toString(toUnixTimestamp(first_event_time)) AS start_s,
              toString(toUnixTimestamp(last_event_time)) AS end_s
       FROM mcp_open_sessions FINAL
       WHERE first_event_time > '2001-01-01'`,
    ),
    // bulk token totals (cost color mode) — UInt64 sums arrive as strings
    chQuery<{ sid: string; tok: string }>(
      `SELECT session_id AS sid,
              toString(sum(input_tokens) + sum(output_tokens) + sum(cache_read_tokens) + sum(cache_write_tokens)) AS tok
       FROM events WHERE event_ts > '2026-01-01' GROUP BY session_id`,
    ),
  ]);
  const tokenMap = new Map(tokenRows.map((r) => [r.sid, Number(r.tok)]));

  const scanMap = readScanMap();
  const langMap = readDominantLangMap();
  const sessions: TimelineSession[] = rows.map((r) => {
    const scan = scanMap.get(r.session_id);
    const lang = langMap.get(r.session_id);
    return {
      id: r.session_id,
      harness: r.harness || "unknown",
      mode: r.mode || "unknown",
      title: r.title,
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

  return Response.json({
    sessions,
    meta: { count: sessions.length, harnesses },
  });
}
