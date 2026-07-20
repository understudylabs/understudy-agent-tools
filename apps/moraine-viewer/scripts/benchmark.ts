// Stage 4, first increment: turn a task cluster into a reviewable PERSONAL
// BENCHMARK DRAFT. Reads scan.sqlite (cluster membership) + commits.sqlite
// (shipped commits) + Moraine ClickHouse (prompts, final answers, tools),
// writes data/benchmarks/<cluster-slug>.json.
//
// Run: bun scripts/benchmark.ts --cluster <id> [--concurrency 6]
//
// Splits are contamination-safe: deterministic FNV-1a hash of session_id →
// train 60% / dev 20% / holdout 20%. Holdout stays sealed — this draft is the
// input to a verifiers-env compile in the next stage.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const CLICKHOUSE = process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const CLUSTER = args.get("--cluster");
const CONCURRENCY = Number(args.get("--concurrency") ?? 2);
if (CLUSTER == null) {
  console.error("usage: bun scripts/benchmark.ts --cluster <id>");
  process.exit(1);
}

const PROMPT_CAP = 4000;
const ANSWER_CAP = 2000;
const SPLIT_SEED = "personal-benchmark-v1";

// Heavy per-session queries can transiently drop connections on the local
// ClickHouse — retry with backoff instead of dropping the instance.
async function ch<T>(sql: string, attempts = 4): Promise<T[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // caps: this script once drove ClickHouse to 83GB tracked memory
      const res = await fetch(`${CLICKHOUSE}/?database=moraine&default_format=JSONEachRow&max_memory_usage=2000000000&max_threads=2&max_execution_time=60`, {
        method: "POST",
        body: `${sql} FORMAT JSONEachRow`,
      });
      if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const text = await res.text();
      return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

// The established payload text fallback (see app/api/session/route.ts).
const TEXT_EXPR = `multiIf(
  length(text_content) > 0, text_content,
  JSONExtractString(payload_json, 'text') != '', JSONExtractString(payload_json, 'text'),
  JSON_VALUE(payload_json, '$.content[0].text') != '', JSON_VALUE(payload_json, '$.content[0].text'),
  JSONExtractString(payload_json, 'input') != '', JSONExtractString(payload_json, 'input'),
  JSONExtractString(payload_json, 'output')
)`;

// FNV-1a 32-bit — deterministic split assignment, stable across runs.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function splitOf(sessionId: string): "train" | "dev" | "holdout" {
  const bucket = fnv1a(`${SPLIT_SEED}:${sessionId}`) % 100;
  if (bucket < 60) return "train";
  if (bucket < 80) return "dev";
  return "holdout";
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// --- membership from scan.sqlite ---
const dataDir = new URL("../data", import.meta.url).pathname;
const scan = new Database(`${dataDir}/scan.sqlite`, { readonly: true });
const cluster = scan.query("SELECT id, name FROM clusters WHERE id = ?").get(Number(CLUSTER)) as
  | { id: number; name: string }
  | null;
if (!cluster) {
  console.error(`no cluster with id ${CLUSTER}`);
  process.exit(1);
}
interface Member {
  session_id: string;
  harness: string;
  events: number;
  label: string | null;
  summary: string | null;
}
const members = scan
  .query(
    `SELECT s.session_id, s.harness, COALESCE(s.events,0) AS events, s.label, s.summary
     FROM session_scan s JOIN cluster_map m ON m.label = s.label
     WHERE m.cluster_id = ? AND s.interactive = 1`,
  )
  .all(Number(CLUSTER)) as Member[];
scan.close();

// --- shipped commits from commits.sqlite ---
const commitsBySession = new Map<string, string[]>();
try {
  const cdb = new Database(`${dataDir}/commits.sqlite`, { readonly: true });
  for (const r of cdb
    .query(
      "SELECT cs.session_id sid, c.subject subj FROM commit_sessions cs JOIN commits c ON c.hash = cs.hash",
    )
    .all() as { sid: string; subj: string }[]) {
    if (!commitsBySession.has(r.sid)) commitsBySession.set(r.sid, []);
    commitsBySession.get(r.sid)!.push(r.subj);
  }
  cdb.close();
} catch {
  /* commits.sqlite absent — references just omit commits */
}

// --- origin_cwd per session, one bulk query ---
const idList = members.map((m) => `'${m.session_id}'`).join(",");
const cwdMap = new Map<string, string>();
if (members.length) {
  for (const r of await ch<{ session_id: string; origin_cwd: string }>(`
    SELECT session_id, anyLast(origin_cwd) AS origin_cwd
    FROM mcp_open_sessions FINAL
    WHERE session_id IN (${idList})
    GROUP BY session_id
  `)) {
    cwdMap.set(r.session_id, r.origin_cwd);
  }
}

interface Instance {
  instance_id: string;
  session_id: string;
  split: "train" | "dev" | "holdout";
  prompt: string;
  context: {
    project: string;
    harness: string;
    tools_used: string[];
    label: string | null;
    summary: string | null;
  };
  reference: {
    final_assistant: string;
    commits: string[];
    events: number;
  };
  quality: number;
}

function isSlashWrapper(t: string): boolean {
  return t.includes("<command-name>") || t.includes("<local-command-caveat>");
}

let dropped = 0;

async function buildInstance(m: Member): Promise<Instance | null> {
  // Main-stream events only — the substream exclusion keeps subagent chatter
  // out of both the prompt and the reference answer.
  const rows = await ch<{ event_type: string; name: string; t: string }>(`
    SELECT event_type, name,
      substring(${TEXT_EXPR}, 1, ${PROMPT_CAP}) AS t
    FROM mcp_open_events
    WHERE session_id = '${m.session_id}'
      AND event_type IN ('user_input', 'assistant_response', 'tool_call')
      AND event_uid IN (
        SELECT event_uid FROM events WHERE session_id = '${m.session_id}' AND is_substream = 0
      )
    ORDER BY event_order ASC, slot DESC, generation DESC
    LIMIT 1 BY event_order
  `);

  const prompt = rows.find(
    (r) => r.event_type === "user_input" && r.t.trim().length > 0 && !isSlashWrapper(r.t),
  )?.t.trim();
  if (!prompt) {
    dropped++;
    return null;
  }

  const finalAssistant =
    rows.filter((r) => r.event_type === "assistant_response" && r.t.trim().length > 0).at(-1)
      ?.t.trim().slice(0, ANSWER_CAP) ?? "";

  const toolCounts = new Map<string, number>();
  for (const r of rows)
    if (r.event_type === "tool_call" && r.name)
      toolCounts.set(r.name, (toolCounts.get(r.name) ?? 0) + 1);
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([n]) => n);

  const commits = commitsBySession.get(m.session_id) ?? [];

  // Quality heuristic 0-1: substantive prompt, a real final answer, shipped commits.
  let quality = 0;
  if (prompt.length > 80) quality += 0.4;
  if (finalAssistant.length > 0) quality += 0.3;
  if (commits.length > 0) quality += 0.3;

  const cwd = cwdMap.get(m.session_id) ?? "";
  const project = cwd.split("/").filter(Boolean).slice(-2).join("/") || "?";

  return {
    instance_id: createHash("sha256").update(m.session_id).digest("hex").slice(0, 16),
    session_id: m.session_id,
    split: splitOf(m.session_id),
    prompt: prompt.slice(0, PROMPT_CAP),
    context: {
      project,
      harness: m.harness,
      tools_used: tools,
      label: m.label,
      summary: m.summary,
    },
    reference: {
      final_assistant: finalAssistant,
      commits: commits.map((c) => c.slice(0, 120)),
      events: Number(m.events),
    },
    quality: Number(quality.toFixed(2)),
  };
}

const instances: Instance[] = [];
const queue = [...members];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const inst = await buildInstance(m);
        if (inst) instances.push(inst);
      } catch (e) {
        dropped++;
        console.error(`fail ${m.session_id.slice(0, 8)}: ${String(e).slice(0, 150)}`);
      }
    }
  }),
);
instances.sort((a, b) => b.quality - a.quality || a.session_id.localeCompare(b.session_id));

const slug = slugify(cluster.name);
const counts = {
  instances: instances.length,
  train: instances.filter((i) => i.split === "train").length,
  dev: instances.filter((i) => i.split === "dev").length,
  holdout: instances.filter((i) => i.split === "holdout").length,
  dropped,
};
const meanQuality = instances.length
  ? Number((instances.reduce((s, i) => s + i.quality, 0) / instances.length).toFixed(3))
  : 0;

const draft = {
  benchmark: `personal.${slug}`,
  version: "benchmark.v1-draft",
  created: args.get("--now") ?? new Date().toISOString(),
  cluster: { id: cluster.id, name: cluster.name },
  counts,
  mean_quality: meanQuality,
  split_hash_seed: SPLIT_SEED,
  instances,
};

mkdirSync(`${dataDir}/benchmarks`, { recursive: true });
const outPath = `${dataDir}/benchmarks/${slug}.json`;
writeFileSync(outPath, `${JSON.stringify(draft, null, 2)}\n`);

console.log(`personal.${slug} — ${outPath}`);
console.log(
  `  instances: ${counts.instances} (train ${counts.train} / dev ${counts.dev} / holdout ${counts.holdout})`,
);
console.log(`  mean quality: ${meanQuality} · dropped: ${dropped} of ${members.length}`);
