// Read-only access to the local Moraine ClickHouse (http://127.0.0.1:8123, db `moraine`).
// Understudy never writes into Moraine's schema — SELECT/SHOW/DESCRIBE only.
// Query the mcp_open_* session-keyed projection where possible; `events` is 53GB-class.
// ReplacingMergeTree: dedup with FINAL (version cols: events.event_version, mcp_open_*.generation).

const CLICKHOUSE_URL = process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";

export async function chQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|show|describe|desc|with)\b/i.test(trimmed)) {
    throw new Error("read-only: only SELECT/SHOW/DESCRIBE queries are allowed");
  }
  // guardrails: a runaway agent once drove tracked memory to 83GB — every
  // query from this app is capped so the viewer can never take the box down
  const settings = new URLSearchParams({
    database: "moraine",
    default_format: "JSONEachRow",
    max_memory_usage: "2000000000", // 2GB per query
    max_threads: "4",
    max_execution_time: "30",
  });
  const res = await fetch(`${CLICKHOUSE_URL}/?${settings}`, {
    method: "POST",
    body: `${trimmed} FORMAT JSONEachRow`,
    headers: { "Content-Type": "text/plain" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

// `model` values are sometimes JSON blobs or filesystem paths — normalize defensively.
export function normalizeModel(raw: string): string {
  if (!raw) return "unknown";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.modelid ?? parsed.model ?? raw;
    } catch {
      return raw;
    }
  }
  if (raw.includes("/")) return raw.split("/").filter(Boolean).pop() ?? raw;
  return raw;
}
