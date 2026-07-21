import { NextRequest } from "next/server";
import { chQuery, normalizeModel } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

type DailyRow = { d: string; harness: string; c: string };
type SessionRow = {
  session_id: string;
  harness: string;
  title: string;
  total_events: string;
  start_s: string;
  end_s: string;
  mode: string;
  model: string;
  inference_provider: string;
};
type DetailRow = {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: string;
  total_events: string;
  user_messages: string;
  tool_calls: string;
  start_s: string;
  end_s: string;
  session_summary: string;
  origin_cwd: string;
  inference_provider: string;
};

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session");

  if (sessionId) {
    // Session detail: summary + rollups for the side panel.
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-.]/g, "");
    const rows = await chQuery<DetailRow>(`
      SELECT
        session_id, title, harness, mode, inference_provider,
        toString(total_turns) AS total_turns,
        toString(total_events) AS total_events,
        toString(user_messages) AS user_messages,
        toString(tool_calls) AS tool_calls,
        toString(toUnixTimestamp(first_event_time)) AS start_s,
        toString(toUnixTimestamp(last_event_time)) AS end_s,
        substring(session_summary, 1, 4000) AS session_summary,
        origin_cwd
      FROM mcp_open_sessions FINAL
      WHERE session_id = '${safe}'
      LIMIT 1
    `);
    if (rows.length === 0) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const r = rows[0];
    return Response.json({
      session: {
        sessionId: r.session_id,
        title: r.title,
        harness: r.harness,
        mode: r.mode,
        provider: r.inference_provider,
        totalTurns: Number(r.total_turns),
        totalEvents: Number(r.total_events),
        userMessages: Number(r.user_messages),
        toolCalls: Number(r.tool_calls),
        start: Number(r.start_s),
        end: Number(r.end_s),
        summary: r.session_summary,
        cwd: r.origin_cwd,
      },
    });
  }

  // 1) Daily event counts per harness (cheap column scan; skip 1970 sentinels).
  const dailyP = chQuery<DailyRow>(`
    SELECT toString(toDate(event_ts)) AS d, harness, toString(count()) AS c
    FROM events
    WHERE event_ts > '2026-01-01' AND harness != ''
    GROUP BY d, harness
    ORDER BY d
  `);

  // 2) Sessions (top 2000 by volume) with a best-effort model per session.
  const sessionsP = chQuery<SessionRow>(`
    SELECT
      s.session_id AS session_id,
      s.harness AS harness,
      s.title AS title,
      toString(s.total_events) AS total_events,
      toString(toUnixTimestamp(s.first_event_time)) AS start_s,
      toString(toUnixTimestamp(s.last_event_time)) AS end_s,
      s.mode AS mode,
      s.inference_provider AS inference_provider,
      m.sess_model AS model
    FROM mcp_open_sessions AS s FINAL
    LEFT JOIN (
      SELECT session_id, anyHeavy(model) AS sess_model
      FROM events
      WHERE model != '' AND event_ts > '2026-01-01'
      GROUP BY session_id
    ) AS m ON m.session_id = s.session_id
    WHERE s.first_event_time > '2026-01-01'
    ORDER BY s.total_events DESC
    LIMIT 2000
  `);

  const [daily, sessions] = await Promise.all([dailyP, sessionsP]);

  return Response.json({
    daily: daily.map((r) => ({ d: r.d, harness: r.harness, c: Number(r.c) })),
    sessions: sessions.map((r) => ({
      id: r.session_id,
      harness: r.harness,
      title: r.title,
      events: Number(r.total_events),
      start: Number(r.start_s),
      end: Number(r.end_s),
      mode: r.mode,
      model: normalizeModel(r.model || r.inference_provider || ""),
    })),
  });
}
