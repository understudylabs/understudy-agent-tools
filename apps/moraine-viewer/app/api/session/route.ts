import { NextRequest } from "next/server";
import { chQuery, normalizeModel } from "@/lib/clickhouse";

// Full lossless transcript API for one session.
// GET /api/session?id=<sid>&cursor=<event_order>&limit=500
// Events come from mcp_open_events (session-keyed projection, deduped with
// `LIMIT 1 BY event_order` over slot/generation DESC — same pattern as
// app/api/anatomy/session). Substream/nesting metadata (is_substream,
// agent_label, agent_run_id) is joined per-page from the base `events`
// table keyed by event_uid in one bulk query.

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

interface SessionRow {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: number;
  total_events: number;
  first_event_time: string;
  last_event_time: string;
}

interface RawEvent {
  event_order: number;
  turn_seq: number;
  event_time: string;
  actor_role: string;
  event_type: string;
  name: string;
  call_id: string;
  event_uid: string;
  text: string;
  text_truncated: number;
  payload_json: string;
  payload_truncated: number;
  tokens: number;
}

interface SubstreamRow {
  uid: string;
  sub: number;
  label: string;
  run: string;
}

export interface TranscriptEvent extends Omit<RawEvent, "event_uid"> {
  is_substream: number;
  agent_label: string;
  agent_run_id: string;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return Response.json({ error: "bad session id" }, { status: 400 });
  }
  const cursor = Math.max(0, Number(params.get("cursor")) || 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT),
  );

  try {
    const [sessions, rawEvents, models, tokenTotals] = await Promise.all([
      chQuery<SessionRow>(`
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
      chQuery<RawEvent>(`
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
        FROM mcp_open_events FINAL
        WHERE session_id = '${id}' AND event_order > ${cursor}
        ORDER BY event_order ASC, slot DESC, generation DESC
        LIMIT 1 BY event_order
        LIMIT ${limit}
      `),
      chQuery<{ model: string }>(`
        SELECT DISTINCT model
        FROM events FINAL
        WHERE session_id = '${id}' AND model != ''
        LIMIT 12
      `),
      chQuery<{ total_tokens: string }>(`
        SELECT toString(sum(arraySum(mapValues(token_usage_buckets)))) AS total_tokens
        FROM (
          SELECT token_usage_buckets
          FROM mcp_open_events FINAL
          WHERE session_id = '${id}'
          ORDER BY event_order ASC, slot DESC, generation DESC
          LIMIT 1 BY event_order
        )
      `),
    ]);

    if (!sessions.length) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }

    // Bulk substream join keyed by event_uid (alias outputs so they don't
    // shadow the filter columns).
    const uids = [
      ...new Set(
        rawEvents.map((e) => e.event_uid).filter((u) => /^[a-f0-9]{16,64}$/.test(u)),
      ),
    ];
    const subMap = new Map<string, SubstreamRow>();
    if (uids.length) {
      const rows = await chQuery<SubstreamRow>(`
        SELECT
          event_uid AS uid,
          toUInt8(max(is_substream)) AS sub,
          anyLast(agent_label) AS label,
          anyLast(agent_run_id) AS run
        FROM events FINAL
        WHERE session_id = '${id}'
          AND event_uid IN (${uids.map((u) => `'${u}'`).join(",")})
        GROUP BY event_uid
      `);
      for (const r of rows) subMap.set(r.uid, r);
    }

    const events: TranscriptEvent[] = rawEvents.map(({ event_uid, ...e }) => {
      const s = subMap.get(event_uid);
      return {
        ...e,
        is_substream: s?.sub ?? 0,
        agent_label: s?.label ?? "",
        agent_run_id: s?.run ?? "",
      };
    });

    const s = sessions[0];
    return Response.json({
      session: {
        id: s.session_id,
        title: s.title,
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
      nextCursor:
        events.length === limit ? events[events.length - 1].event_order : null,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
