import type { NextRequest } from "next/server";
import { chQuery } from "@/lib/clickhouse";
import type { MapPoint } from "@/components/map/types";

// GET /api/map            → { points, meta }  (all sessions, placeholder 2D projection)
// GET /api/map?session=id → { session }       (detail incl. session_summary)

interface SessionRow {
  session_id: string;
  title: string;
  harness: string;
  mode: string;
  total_turns: number;
  total_events: number;
  tool_calls: number;
  first_event_time: string;
  last_event_time: string;
}

// deterministic jitter from session_id — stable across reloads
function hashJitter(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  // map uint32 → [-1, 1]
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session");

  if (sessionId) {
    const rows = await chQuery<SessionRow & { session_summary: string; source: string; origin_cwd: string }>(
      `SELECT session_id, title, harness, mode, total_turns, total_events, tool_calls,
              first_event_time, last_event_time, session_summary, source, origin_cwd
       FROM mcp_open_sessions FINAL
       WHERE session_id = '${sessionId.replace(/'/g, "\\'")}'
       LIMIT 1`,
    );
    if (rows.length === 0) {
      return Response.json({ error: "session not found" }, { status: 404 });
    }
    return Response.json({ session: rows[0] });
  }

  const rows = await chQuery<SessionRow>(
    `SELECT session_id, title, harness, mode,
            toUInt32(total_turns) AS total_turns,
            toUInt32(total_events) AS total_events,
            toUInt32(tool_calls) AS tool_calls,
            first_event_time, last_event_time
     FROM mcp_open_sessions FINAL
     WHERE first_event_time > '2001-01-01' AND mode != 'mcp_internal'`,
  );

  // Engineered feature axes (no embeddings yet — Stage 2):
  //   x = activity scale: log(total_events) blended with log(duration)
  //   y = tool-heaviness: tool_call ratio blended with log(turns)
  const feats = rows.map((r) => {
    const durS = Math.max(
      0,
      (new Date(r.last_event_time + "Z").getTime() - new Date(r.first_event_time + "Z").getTime()) / 1000,
    );
    return {
      e: Math.log1p(r.total_events),
      d: Math.log1p(durS),
      t: Math.log1p(r.total_turns),
      r: r.tool_calls / Math.max(1, r.total_events),
    };
  });

  const norm = (vals: number[]) => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    return vals.map((v) => (v - lo) / span);
  };
  const en = norm(feats.map((f) => f.e));
  const dn = norm(feats.map((f) => f.d));
  const tn = norm(feats.map((f) => f.t));
  const rn = norm(feats.map((f) => f.r));

  const points: MapPoint[] = rows.map((r, i) => {
    const x = 0.6 * en[i] + 0.4 * dn[i] + 0.018 * hashJitter(r.session_id, 1);
    const y = 0.65 * rn[i] + 0.35 * tn[i] + 0.018 * hashJitter(r.session_id, 2);
    return {
      id: r.session_id,
      x: Number((x * 100 - 50).toFixed(3)), // world units, roughly [-50, 50]
      y: Number((y * 100 - 50).toFixed(3)),
      size: Number((2.2 + 5.5 * en[i]).toFixed(2)), // px, ~ log events
      harness: r.harness || "unknown",
      mode: r.mode || "unknown",
      title: r.title,
      turns: r.total_turns,
      events: r.total_events,
      toolCalls: r.tool_calls,
      date: r.first_event_time,
    };
  });

  const harnesses = [...new Set(points.map((p) => p.harness))].sort();
  const modes = [...new Set(points.map((p) => p.mode))].sort();

  return Response.json({
    points,
    meta: {
      count: points.length,
      harnesses,
      modes,
      projection: "placeholder projection — embeddings land in Stage 2",
      axes: { x: "activity scale (log events + log duration)", y: "tool-heaviness (tool ratio + log turns)" },
    },
  });
}
