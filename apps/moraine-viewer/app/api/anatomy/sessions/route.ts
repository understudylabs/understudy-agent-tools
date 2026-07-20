import { chQuery } from "@/lib/clickhouse";
import type { SessionRow } from "@/components/anatomy/types";

// Recent claude-code/codex sessions kept legible for the anatomy view (20–400 events).
export async function GET() {
  try {
    type Row = Omit<SessionRow, "first_event_time" | "last_event_time"> & {
      first_event_time_str: string;
      last_event_time_str: string;
    };
    const raw = await chQuery<Row>(`
      SELECT
        session_id,
        title,
        harness,
        toUInt32(total_turns) AS total_turns,
        toUInt32(total_events) AS total_events,
        toUInt32(tool_calls) AS tool_calls,
        toString(first_event_time) AS first_event_time_str,
        toString(last_event_time) AS last_event_time_str
      FROM mcp_open_sessions FINAL
      WHERE harness IN ('claude-code', 'codex')
        AND total_events BETWEEN 20 AND 400
        AND last_event_time > toDateTime64('1971-01-01 00:00:00', 3)
      ORDER BY last_event_time DESC
      LIMIT 60
    `);
    const sessions: SessionRow[] = raw.map(
      ({ first_event_time_str, last_event_time_str, ...rest }) => ({
        ...rest,
        first_event_time: first_event_time_str,
        last_event_time: last_event_time_str,
      }),
    );
    return Response.json({ sessions });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
