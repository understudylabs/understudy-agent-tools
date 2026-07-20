import { NextRequest } from "next/server";
import { chQuery, normalizeModel } from "@/lib/clickhouse";
import type { EventRow, SessionDetail, SessionRow } from "@/components/anatomy/types";

const MAX_EVENTS = 2000;

// Full dissection of one session: deduped event stream + models + token totals.
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return Response.json({ error: "bad session id" }, { status: 400 });
  }
  try {
    const [sessions, events, models] = await Promise.all([
      chQuery<SessionRow>(`
        SELECT
          session_id, title, harness,
          toUInt32(total_turns) AS total_turns,
          toUInt32(total_events) AS total_events,
          toUInt32(tool_calls) AS tool_calls,
          toString(first_event_time) AS first_event_time,
          toString(last_event_time) AS last_event_time
        FROM mcp_open_sessions FINAL
        WHERE session_id = '${id}'
        ORDER BY generation DESC
        LIMIT 1
      `),
      chQuery<EventRow>(`
        SELECT
          toUInt32(event_order) AS event_order,
          toUInt32(turn_seq) AS turn_seq,
          toString(event_time) AS event_time,
          actor_role, event_type, name, call_id,
          substring(
            multiIf(
              length(text_content) > 0, text_content,
              JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
              JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
              JSONExtractString(payload_json, 'input') != '', JSONExtractString(payload_json, 'input'),
              JSONExtractString(payload_json, 'output')
            ), 1, 1200
          ) AS preview,
          toUInt32(greatest(length(text_content), length(payload_json))) AS text_len,
          toUInt32(
            token_usage_buckets['output_text']
            + token_usage_buckets['input_text']
            + token_usage_buckets['reasoning']
          ) AS tokens
        FROM mcp_open_events
        WHERE session_id = '${id}'
        ORDER BY event_order ASC, slot DESC, generation DESC
        LIMIT 1 BY event_order
        LIMIT ${MAX_EVENTS}
      `),
      chQuery<{ model: string }>(`
        SELECT DISTINCT model
        FROM events
        WHERE session_id = '${id}' AND model != ''
        LIMIT 12
      `),
    ]);
    if (!sessions.length) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }
    const detail: SessionDetail = {
      session: sessions[0],
      events,
      models: [...new Set(models.map((m) => normalizeModel(m.model)))],
      totalTokens: events.reduce((acc, e) => acc + e.tokens, 0),
      truncated: events.length >= MAX_EVENTS,
    };
    return Response.json(detail);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
