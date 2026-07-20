import { chQuery } from "@/lib/clickhouse";

// GET /api/timeline/live → { now, ids } — sessions active in the last 120s.
// Query window is 150s; the 120s cut happens here against ClickHouse's own now()
// (event clocks can run ahead of the server, so ahead-of-now counts as live).
// Alias-shadowing gotcha: aliases (sid / last_s) must differ from column names
// or the WHERE filter on last_event_time breaks.

export async function GET() {
  const [rows, nowRows] = await Promise.all([
    chQuery<{ sid: string; last_s: string }>(
      `SELECT session_id AS sid,
              toString(toUnixTimestamp(last_event_time)) AS last_s
       FROM mcp_open_sessions FINAL
       WHERE last_event_time > now() - INTERVAL 150 SECOND`,
    ),
    chQuery<{ n: string }>(`SELECT toString(toUnixTimestamp(now())) AS n`),
  ]);
  const now = Number(nowRows[0]?.n ?? Math.floor(Date.now() / 1000));
  const ids = rows.filter((r) => now - Number(r.last_s) <= 120).map((r) => r.sid);
  return Response.json({ now, ids });
}
