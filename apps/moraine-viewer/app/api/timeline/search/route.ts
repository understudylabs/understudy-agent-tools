import type { NextRequest } from "next/server";
import { chQuery } from "@/lib/clickhouse";
import type { SearchResult } from "@/components/timeline/types";

// GET /api/timeline/search?q=… → { q, count, ids, results }
// Case-insensitive server-side match over mcp_open_sessions FINAL
// (title, session_summary, origin_cwd, session_slug ILIKE). ~5.6k rows — fast.

const SNIPPET_LEN = 140;

interface Row {
  session_id: string;
  title: string;
  session_summary: string;
  origin_cwd: string;
  session_slug: string;
}

function snippetFor(row: Row, q: string): { field: string; snippet: string } {
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

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return Response.json({ q: "", count: 0, ids: [], results: [] });
  }

  // escape for a single-quoted ILIKE pattern
  const escaped = q
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const pat = `'%${escaped}%'`;

  const rows = await chQuery<Row>(
    `SELECT session_id, title,
            substring(session_summary, 1, 4000) AS session_summary,
            origin_cwd, session_slug
     FROM mcp_open_sessions FINAL
     WHERE first_event_time > '2001-01-01'
       AND (title ILIKE ${pat}
         OR session_summary ILIKE ${pat}
         OR origin_cwd ILIKE ${pat}
         OR session_slug ILIKE ${pat})`,
  );

  const ids = rows.map((r) => r.session_id);
  const results: SearchResult[] = rows.slice(0, 40).map((r) => ({
    id: r.session_id,
    ...snippetFor(r, q),
  }));

  return Response.json({ q, count: ids.length, ids, results });
}
