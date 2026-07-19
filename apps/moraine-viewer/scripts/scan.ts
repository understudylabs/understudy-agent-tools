// Stage 2 sample scanner: label + summarize sessions with the local Gemma rung.
// Reads Moraine ClickHouse (read-only), writes to an Understudy-owned SQLite at
// data/scan.sqlite. Run: bun scripts/scan.ts [--limit 500] [--concurrency 2]
//
// Digest per session = first user inputs + tool mix + shape stats; the model
// returns {"label": "2-4 word task type", "summary": "1-2 sentences"}.

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const CLICKHOUSE = process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const LLM = process.env.SCAN_LLM_URL ?? "http://127.0.0.1:8877/v1/chat/completions";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const LIMIT = Number(args.get("--limit") ?? 500);
const CONCURRENCY = Number(args.get("--concurrency") ?? 2);

async function ch<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${CLICKHOUSE}/?database=moraine&default_format=JSONEachRow`, {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
}

mkdirSync(new URL("../data", import.meta.url).pathname, { recursive: true });
const db = new Database(new URL("../data/scan.sqlite", import.meta.url).pathname);
db.run(`CREATE TABLE IF NOT EXISTS session_scan (
  session_id TEXT PRIMARY KEY,
  harness TEXT, events INTEGER,
  label TEXT, summary TEXT,
  digest TEXT, model TEXT, scanned_at TEXT DEFAULT (datetime('now'))
)`);

interface Sess { session_id: string; harness: string; total_events: number; origin_cwd: string; mode: string }

const done = new Set(
  (db.query("SELECT session_id FROM session_scan").all() as { session_id: string }[]).map((r) => r.session_id),
);

const sessions = (
  await ch<Sess>(`
    SELECT session_id, harness, toUInt32(total_events) AS total_events, origin_cwd, mode
    FROM mcp_open_sessions FINAL
    WHERE total_events >= 10 AND first_event_time > toDateTime64('2001-01-01 00:00:00', 3)
      AND mode != 'mcp_internal'
    ORDER BY last_event_time DESC
    LIMIT ${LIMIT}
  `)
).filter((s) => !done.has(s.session_id));

console.log(`${sessions.length} sessions to scan (${done.size} already done)`);

async function digestOf(s: Sess): Promise<string> {
  const rows = await ch<{ event_type: string; name: string; t: string }>(`
    SELECT event_type, name,
      substring(multiIf(
        length(text_content) > 0, text_content,
        JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
        JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
        JSONExtractString(payload_json, 'input')
      ), 1, 500) AS t
    FROM mcp_open_events FINAL
    WHERE session_id = '${s.session_id}' AND event_type IN ('user_input', 'assistant_response', 'tool_call')
      -- subagent chatter skews labels toward what the subagents were told; main stream only
      AND event_uid IN (
        SELECT event_uid FROM events WHERE session_id = '${s.session_id}' AND is_substream = 0
      )
    ORDER BY event_order ASC, slot DESC, generation DESC
    LIMIT 1 BY event_order
    LIMIT 300
  `);
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  // all user inputs (capped), assistant messages sampled across the whole arc
  const users = rows.filter((r) => r.event_type === "user_input" && r.t.trim()).slice(0, 8);
  const assistants = rows.filter((r) => r.event_type === "assistant_response" && r.t.trim());
  const pick = new Set<number>([0, Math.floor(assistants.length / 2), assistants.length - 1]);
  const sampledAssistants = [...pick].filter((i) => i >= 0 && i < assistants.length).sort((a, b) => a - b);
  const toolCounts = new Map<string, number>();
  for (const r of rows) if (r.event_type === "tool_call" && r.name) toolCounts.set(r.name, (toolCounts.get(r.name) ?? 0) + 1);
  const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([n, c]) => `${n}×${c}`).join(", ");
  const proj = s.origin_cwd.split("/").filter(Boolean).slice(-2).join("/");
  return [
    `harness: ${s.harness} · mode: ${s.mode} · events: ${s.total_events} · project: ${proj || "?"}`,
    tools ? `tools: ${tools}` : "",
    ...users.map((u, i) => `user[${i}]: ${clean(u.t)}`),
    ...sampledAssistants.map((i) => {
      const pos = i === 0 ? "first" : i === assistants.length - 1 ? "last" : "mid";
      return `assistant[${pos}]: ${clean(assistants[i].t).slice(0, 350)}`;
    }),
  ].filter(Boolean).join("\n");
}

async function labelOf(digest: string): Promise<{ label: string; summary: string }> {
  const res = await fetch(LLM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "default_model",
      temperature: 0.2,
      max_tokens: 2000, // generous: reasoning eats the budget before the answer
      messages: [
        {
          role: "system",
          content:
            "You label coding-agent sessions. Given a session digest, respond with ONLY a JSON object: " +
            '{"label": "<2-4 word task type, lowercase, reusable across similar sessions (e.g. \\"fix failing tests\\", \\"data pipeline work\\", \\"ui prototyping\\", \\"model evaluation\\", \\"repo exploration\\")>", "summary": "<1-2 sentence summary of what happened>"}',
        },
        { role: "user", content: digest },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  const raw = j.choices[0]?.message?.content ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]) as { label?: string; summary?: string };
  return {
    label: (parsed.label ?? "unlabeled").toLowerCase().trim().slice(0, 60),
    summary: (parsed.summary ?? "").trim().slice(0, 500),
  };
}

const insert = db.prepare(
  "INSERT OR REPLACE INTO session_scan (session_id, harness, events, label, summary, digest, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

let ok = 0, failed = 0;
const t0 = Date.now();
const queue = [...sessions];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        const digest = await digestOf(s);
        const { label, summary } = await labelOf(digest);
        insert.run(s.session_id, s.harness, s.total_events, label, summary, digest, "gemma-4-e2b-qat-understudy");
        ok++;
        if (ok % 20 === 0) {
          const rate = ok / ((Date.now() - t0) / 1000);
          console.log(`${ok}/${sessions.length} ok (${failed} failed) — ${rate.toFixed(2)}/s, eta ${Math.round((sessions.length - ok - failed) / rate / 60)}m`);
        }
      } catch (e) {
        failed++;
        console.error(`fail ${s.session_id.slice(0, 8)}: ${String(e).slice(0, 150)}`);
      }
    }
  }),
);
console.log(`done: ${ok} ok, ${failed} failed in ${Math.round((Date.now() - t0) / 1000)}s`);
const top = db.query("SELECT label, COUNT(*) c FROM session_scan GROUP BY label ORDER BY c DESC LIMIT 15").all();
console.log("top labels:", JSON.stringify(top));
