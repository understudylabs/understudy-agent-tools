import { chQuery } from "@/lib/clickhouse";

// GET /api/timeline/health → { lastEventAgoS, ingesting }
// max() over an empty day comes back as unix 0 — treat that as stale.
// Some event clocks run ahead of the server, so clamp negative ages to 0.

export async function GET() {
  const rows = await chQuery<{ m: string; n: string }>(
    `SELECT toString(toUnixTimestamp(max(event_ts))) AS m,
            toString(toUnixTimestamp(now())) AS n
     FROM events WHERE event_ts > now() - INTERVAL 1 DAY`,
  );
  const m = Number(rows[0]?.m ?? 0);
  const now = Number(rows[0]?.n ?? Math.floor(Date.now() / 1000));
  const lastEventAgoS = m > 0 ? Math.max(0, now - m) : 86400;
  return Response.json({ lastEventAgoS, ingesting: lastEventAgoS < 300 });
}
