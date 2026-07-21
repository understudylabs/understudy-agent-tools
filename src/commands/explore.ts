// `understudy explore` — port of the Moraine viewer scan pipeline
// (apps/moraine-viewer/scripts/{scan,cluster,commits,languages}.ts).
//
// Reads Moraine ClickHouse (read-only, capped per query) and writes
// Understudy-owned SQLite stores under ~/.understudy/explore/
// (override with UNDERSTUDY_EXPLORE_DIR):
//   scan.sqlite    — session_scan, clusters, cluster_map
//   commits.sqlite — commits, commit_sessions, commit_sessions_related
//   langs.sqlite   — session_langs, session_tools
//
// The scan/cluster labeling model is any OpenAI-compatible chat-completions
// endpoint — including the desktop app's resident model server — selected
// with --llm-url (default http://127.0.0.1:8877/v1/chat/completions,
// model name "default_model").

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";

const DEFAULT_LLM_URL = "http://127.0.0.1:8877/v1/chat/completions";
const LLM_MODEL = "default_model";

export function exploreDir(): string {
  const dir = process.env.UNDERSTUDY_EXPLORE_DIR ?? join(homedir(), ".understudy", "explore");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- ClickHouse (read-only, per-query resource caps as URL params) -------------

export function clickhouseUrl(): string {
  return process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
}

export async function ch<T>(sql: string): Promise<T[]> {
  const params =
    "database=moraine&default_format=JSONEachRow" +
    "&max_memory_usage=2000000000&max_threads=4&max_execution_time=30";
  const res = await fetch(`${clickhouseUrl()}/?${params}`, {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
}

// --- LLM ------------------------------------------------------------------------

async function llmJson(
  llmUrl: string,
  system: string,
  user: string,
  opts: { temperature: number; maxTokens: number },
): Promise<string> {
  const res = await fetch(llmUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens, // generous: reasoning eats the budget before the answer
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

function extractJson(raw: string): string {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in: ${raw.slice(0, 160)}`);
  return m[0];
}

// =================================================================================
// scan — label + summarize sessions
// =================================================================================

interface Sess {
  session_id: string;
  harness: string;
  total_events: number;
  origin_cwd: string;
  mode: string;
  user_messages: number;
}

function openScanDb(): DatabaseSync {
  const db = new DatabaseSync(join(exploreDir(), "scan.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS session_scan (
    session_id TEXT PRIMARY KEY,
    harness TEXT, events INTEGER,
    label TEXT, summary TEXT,
    digest TEXT, model TEXT, scanned_at TEXT DEFAULT (datetime('now'))
  )`);
  for (const col of ["interactive INTEGER DEFAULT 1", "user_messages INTEGER DEFAULT 0", "sub_events INTEGER DEFAULT 0"]) {
    try { db.exec(`ALTER TABLE session_scan ADD COLUMN ${col}`); } catch { /* exists */ }
  }
  return db;
}

async function runScan(opts: { limit: number; concurrency: number; llmUrl: string }): Promise<void> {
  const db = openScanDb();
  const done = new Set(
    (db.prepare("SELECT session_id FROM session_scan").all() as { session_id: string }[]).map((r) => r.session_id),
  );

  // commits shipped by a session are a strong signal of what the task actually was
  const commitsBySession = new Map<string, string[]>();
  try {
    const cdb = new DatabaseSync(join(exploreDir(), "commits.sqlite"), { readOnly: true });
    for (const r of cdb
      .prepare("SELECT cs.session_id sid, c.subject subj FROM commit_sessions cs JOIN commits c ON c.hash = cs.hash")
      .all() as { sid: string; subj: string }[]) {
      if (!commitsBySession.has(r.sid)) commitsBySession.set(r.sid, []);
      commitsBySession.get(r.sid)!.push(r.subj);
    }
    cdb.close();
  } catch { /* commits.sqlite absent — digest just omits the line */ }

  const sessions = (
    await ch<Sess>(`
      SELECT session_id, harness, toUInt32(total_events) AS total_events, origin_cwd, mode,
        toUInt32(user_messages) AS user_messages
      FROM mcp_open_sessions FINAL
      WHERE total_events >= 5 AND first_event_time > toDateTime64('2001-01-01 00:00:00', 3)
        AND mode != 'mcp_internal'
        -- interactive work only: a human sent multiple messages, and it isn't a
        -- giant machine-generated rollout stream
        AND user_messages >= 1
        AND total_events <= 3000
      ORDER BY last_event_time DESC
      LIMIT ${opts.limit}
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
      FROM mcp_open_events
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
    const commits = commitsBySession.get(s.session_id) ?? [];
    return [
      `harness: ${s.harness} · mode: ${s.mode} · events: ${s.total_events} · project: ${proj || "?"}`,
      tools ? `tools: ${tools}` : "",
      commits.length
        ? `commits shipped (${commits.length}): ${commits.slice(0, 3).map((c) => c.slice(0, 80)).join(" | ")}`
        : "",
      ...users.map((u, i) => `user[${i}]: ${clean(u.t)}`),
      ...sampledAssistants.map((i) => {
        const pos = i === 0 ? "first" : i === assistants.length - 1 ? "last" : "mid";
        return `assistant[${pos}]: ${clean(assistants[i].t).slice(0, 350)}`;
      }),
    ].filter(Boolean).join("\n");
  }

  async function labelOf(digest: string): Promise<{ label: string; summary: string }> {
    const raw = await llmJson(
      opts.llmUrl,
      "You label coding-agent sessions by their PURPOSE — what the user was trying to accomplish, " +
        "not how the session started. Agents always begin by reading/exploring the repo; that is never " +
        "the task itself, so labels like \"repo exploration\" are wrong unless understanding the code was " +
        "the user's entire goal. The last assistant message usually reveals the outcome — weight it heavily. " +
        "Respond with ONLY a JSON object: " +
        '{"label": "<2-4 word task type, lowercase, reusable across similar sessions (e.g. \\"fix failing tests\\", \\"data pipeline work\\", \\"ui prototyping\\", \\"model evaluation\\", \\"release management\\")>", "summary": "<1-2 sentence summary: what was accomplished and how it ended>"}',
      digest,
      { temperature: 0.2, maxTokens: 2000 },
    );
    const parsed = JSON.parse(extractJson(raw)) as { label?: string; summary?: string };
    return {
      label: (parsed.label ?? "unlabeled").toLowerCase().trim().slice(0, 60),
      summary: (parsed.summary ?? "").trim().slice(0, 500),
    };
  }

  const insert = db.prepare(
    "INSERT OR REPLACE INTO session_scan (session_id, harness, events, label, summary, digest, model, interactive, user_messages, sub_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  // slash-command invocations (/usage, /doctor, …) are CLI plumbing, not tasks —
  // label them deterministically, skip the model, and mark non-interactive
  function slashCommandOf(digest: string): string | null {
    const userLines = digest.split("\n").filter((l) => /^user\[\d+\]:/.test(l));
    if (!userLines.length) return null;
    const meaningful = userLines.filter((l) => !l.includes("<local-command-caveat>"));
    if (!meaningful.length || !meaningful.every((l) => l.includes("<command-name>"))) return null;
    return meaningful[0].match(/<command-name>([^<]+)<\/command-name>/)?.[1]?.trim() ?? "/unknown";
  }

  async function subEventsOf(sessionId: string): Promise<number> {
    const r = await ch<{ n: string }>(
      `SELECT toString(countIf(is_substream = 1)) AS n FROM events WHERE session_id = '${sessionId}'`,
    );
    return Number(r[0]?.n ?? 0);
  }

  let ok = 0, failed = 0;
  const t0 = Date.now();
  const queue = [...sessions];
  await Promise.all(
    Array.from({ length: opts.concurrency }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const [digest, subEvents] = await Promise.all([digestOf(s), subEventsOf(s.session_id)]);
          const cmd = slashCommandOf(digest);
          if (cmd) {
            insert.run(s.session_id, s.harness, s.total_events, "cli command", `Slash-command invocation: ${cmd}`, digest, "deterministic", 0, s.user_messages, subEvents);
            ok++;
            continue;
          }
          const { label, summary } = await labelOf(digest);
          insert.run(s.session_id, s.harness, s.total_events, label, summary, digest, LLM_MODEL, 1, s.user_messages, subEvents);
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
  const top = db.prepare("SELECT label, COUNT(*) c FROM session_scan GROUP BY label ORDER BY c DESC LIMIT 15").all();
  console.log("top labels:", JSON.stringify(top));
  db.close();
}

// =================================================================================
// cluster — consolidate free-form labels into canonical clusters
// =================================================================================

async function runCluster(opts: { llmUrl: string }): Promise<void> {
  const db = openScanDb();
  db.exec(`CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_map (label TEXT PRIMARY KEY, cluster_id INTEGER)`);

  // deterministic plumbing labels get their own pinned cluster — never blended
  // into real work clusters
  const PINNED = ["cli command"];
  const labels = (db
    .prepare("SELECT label, COUNT(*) c FROM session_scan GROUP BY label ORDER BY c DESC")
    .all() as { label: string; c: number }[]).filter((l) => !PINNED.includes(l.label));
  if (!labels.length) {
    console.log("no labels yet — run `understudy explore scan` first");
    db.close();
    return;
  }
  console.log(`${labels.length} distinct labels over ${labels.reduce((a, l) => a + l.c, 0)} sessions`);

  // only repeated labels go to the model — 300+ singletons blow the token budget;
  // singletons are assigned afterwards (batched LLM, then stemmed word overlap)
  const repeated = labels.filter((l) => l.c >= 2);
  const singletons = labels.filter((l) => l.c < 2);
  console.log(`${repeated.length} repeated labels to the model, ${singletons.length} singletons assigned locally`);
  const histogram = repeated.map((l) => `${l.label} (${l.c})`).join("\n");
  const raw = await llmJson(
    opts.llmUrl,
    "You consolidate task labels from coding-agent sessions into canonical clusters. " +
      "Given a label histogram, group ALL labels into 6-10 clusters of similar work. " +
      'Respond with ONLY JSON: {"clusters": [{"name": "<2-3 word cluster name>", "labels": ["<every input label assigned here>"]}]}. ' +
      "Every input label must appear in exactly one cluster.",
    histogram,
    { temperature: 0.2, maxTokens: 12000 }, // reasoning eats most of this before the JSON appears
  );
  const parsed = JSON.parse(extractJson(raw)) as { clusters: { name: string; labels: string[] }[] };

  db.exec("DELETE FROM clusters");
  db.exec("DELETE FROM cluster_map");
  const insCluster = db.prepare("INSERT INTO clusters (id, name) VALUES (?, ?)");
  const insMap = db.prepare("INSERT OR REPLACE INTO cluster_map (label, cluster_id) VALUES (?, ?)");
  const assigned = new Set<string>();
  parsed.clusters.forEach((c, i) => {
    insCluster.run(i, c.name.toLowerCase().trim().slice(0, 40));
    for (const l of c.labels) {
      insMap.run(l.toLowerCase().trim(), i);
      assigned.add(l.toLowerCase().trim());
    }
  });

  // singletons + anything the model forgot: batched LLM assignment against the
  // canonical cluster list; stemmed word overlap as fallback; last resort "other"
  const STOP = new Set(["and", "the", "of", "for", "a", "an", "in", "on", "with", "to", "&"]);
  const stem = (w: string) => w.replace(/(ing|ment|tion|s)$/, "");
  const words = (s: string) =>
    s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
  const clusterNames = parsed.clusters.map((c) => c.name.toLowerCase().trim().slice(0, 40));
  const clusterVocab = parsed.clusters.map((c) => {
    const v = new Set<string>(words(c.name));
    for (const l of c.labels) for (const w of words(l)) v.add(w);
    return v;
  });

  async function assignBatch(batch: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let content: string;
    try {
      content = await llmJson(
        opts.llmUrl,
        `Assign each task label to the best-fitting cluster. Clusters (use the index): ` +
          clusterNames.map((n, i) => `${i}=${n}`).join(", ") +
          `. Respond ONLY with JSON: {"assignments": {"<label>": <cluster index>, ...}} covering every label.`,
        batch.join("\n"),
        { temperature: 0.1, maxTokens: 8000 },
      );
    } catch {
      return out;
    }
    const mm = content.match(/\{[\s\S]*\}/);
    if (!mm) return out;
    try {
      const a = (JSON.parse(mm[0]) as { assignments?: Record<string, number> }).assignments ?? {};
      for (const [label, idx] of Object.entries(a)) {
        if (Number.isInteger(idx) && idx >= 0 && idx < clusterNames.length) out.set(label.toLowerCase().trim(), idx);
      }
    } catch { /* fall through to overlap */ }
    return out;
  }

  const otherId = parsed.clusters.length;
  const missed = labels.filter((l) => !assigned.has(l.label));
  let llmAssigned = 0, overlapAssigned = 0, toOther = 0;
  const BATCH = 40;
  for (let i = 0; i < missed.length; i += BATCH) {
    const batch = missed.slice(i, i + BATCH);
    const byLlm = await assignBatch(batch.map((l) => l.label));
    for (const l of batch) {
      const idx = byLlm.get(l.label);
      if (idx !== undefined) { insMap.run(l.label, idx); llmAssigned++; continue; }
      let best = -1, bestScore = 0;
      clusterVocab.forEach((v, ci) => {
        const score = words(l.label).filter((w) => v.has(w)).length;
        if (score > bestScore) { bestScore = score; best = ci; }
      });
      if (best >= 0) { insMap.run(l.label, best); overlapAssigned++; }
      else { insMap.run(l.label, otherId); toOther++; }
    }
    console.log(`assigned ${Math.min(i + BATCH, missed.length)}/${missed.length} stragglers`);
  }
  if (toOther) insCluster.run(otherId, "other");
  console.log(`${llmAssigned} by LLM, ${overlapAssigned} by stemmed overlap, ${toOther} → "other"`);

  // pinned plumbing cluster, after everything else
  const pinnedId = otherId + 1;
  insCluster.run(pinnedId, "cli plumbing");
  for (const l of PINNED) insMap.run(l, pinnedId);

  const report = db
    .prepare(`
      SELECT c.name, COUNT(s.session_id) sessions
      FROM session_scan s
      JOIN cluster_map m ON m.label = s.label
      JOIN clusters c ON c.id = m.cluster_id
      GROUP BY c.id ORDER BY sessions DESC
    `)
    .all();
  console.log("clusters:", JSON.stringify(report, null, 1));
  db.close();
}

// =================================================================================
// commits — git-log harvest + session attribution
// =================================================================================

function git(dir: string, args: string[]): string | null {
  try {
    const p = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (p.status !== 0) return null;
    return (p.stdout ?? "").trim();
  } catch {
    return null;
  }
}

async function runCommits(): Promise<void> {
  const MAX_REPOS = 100;

  // --- 1. discover candidate dirs from ClickHouse -----------------------------
  const dirs = new Set<string>();
  for (const q of [
    `SELECT DISTINCT worktree_root AS d FROM events WHERE worktree_root != '' AND event_ts > '2026-01-01'`,
    `SELECT DISTINCT cwd AS d FROM events WHERE cwd != '' AND event_ts > '2026-01-01'`,
  ]) {
    try {
      for (const r of await ch<{ d: string }>(q)) dirs.add(r.d);
    } catch (e) {
      console.error(`discovery query failed: ${String(e).slice(0, 200)}`);
    }
  }
  console.log(`${dirs.size} candidate dirs from clickhouse`);

  // normalize to git toplevels, dedupe, skip missing dirs
  const repos = new Set<string>();
  for (const d of dirs) {
    if (repos.size >= MAX_REPOS) break;
    if (!existsSync(d)) continue;
    const top = git(d, ["rev-parse", "--show-toplevel"]);
    if (top) repos.add(top);
  }
  console.log(`${repos.size} git repos (cap ${MAX_REPOS})`);

  // --- 2. harvest commits -----------------------------------------------------
  const db = new DatabaseSync(join(exploreDir(), "commits.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS commits (
    hash TEXT PRIMARY KEY,
    repo TEXT,
    ts INTEGER,
    author_email TEXT,
    subject TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS commit_sessions (
    hash TEXT,
    session_id TEXT,
    PRIMARY KEY (hash, session_id)
  )`);

  // the user's identities: git config user.email across repos + fuzzy name match
  const myEmails = new Set<string>();
  const myNames = new Set<string>();
  for (const repo of repos) {
    const email = git(repo, ["config", "user.email"]);
    if (email) myEmails.add(email.toLowerCase());
    const name = git(repo, ["config", "user.name"]);
    if (name) for (const part of name.toLowerCase().split(/\s+/)) if (part.length > 2) myNames.add(part);
  }
  console.log(`identities: ${[...myEmails].join(", ") || "(none)"}`);

  type Commit = { hash: string; repo: string; ts: number; email: string; name: string; subject: string };
  const all: Commit[] = [];
  let reposScanned = 0;
  for (const repo of repos) {
    const out = git(repo, [
      "log", "--all", "--no-merges", "--since=2026-01-01",
      "--pretty=format:%H%x09%ct%x09%ae%x09%an%x09%s",
    ]);
    if (out === null) continue;
    reposScanned++;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [hash, ct, ae, an, ...rest] = line.split("\t");
      if (!hash || !ct) continue;
      all.push({ hash, repo, ts: Number(ct), email: (ae ?? "").toLowerCase(), name: an ?? "", subject: rest.join("\t") ?? "" });
    }
  }

  // keep commits by the user (config emails ∪ fuzzy: author name shares a
  // word with any configured user.name)
  const mine = all.filter(
    (c) => myEmails.has(c.email) || c.name.toLowerCase().split(/\s+/).some((w) => myNames.has(w)),
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO commits (hash, repo, ts, author_email, subject) VALUES (?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  for (const c of mine) insert.run(c.hash, c.repo, c.ts, c.email, c.subject);
  db.exec("COMMIT");

  // --- 3. map commits → sessions -----------------------------------------------
  // alias names differ from column names (ClickHouse alias-shadowing bug)
  type ChSess = { sid: string; ocwd: string; start_s: string; end_s: string };
  const sessions = await ch<ChSess>(`
    SELECT session_id AS sid, origin_cwd AS ocwd,
           toString(toUnixTimestamp(first_event_time)) AS start_s,
           toString(toUnixTimestamp(last_event_time)) AS end_s
    FROM mcp_open_sessions FINAL
    WHERE first_event_time > '2001-01-01' AND origin_cwd != ''
  `);
  console.log(`${sessions.length} sessions from clickhouse`);

  // each commit attributes to its single BEST session — most specific path match
  // wins (exact cwd beats repo prefix), then smallest time distance to session
  // end; all other window matches are kept as secondary "related" edges
  db.exec(`CREATE TABLE IF NOT EXISTS commit_sessions_related (
    hash TEXT, session_id TEXT, PRIMARY KEY (hash, session_id)
  )`);
  db.exec("DELETE FROM commit_sessions");
  db.exec("DELETE FROM commit_sessions_related");
  const insertMap = db.prepare("INSERT OR IGNORE INTO commit_sessions (hash, session_id) VALUES (?, ?)");
  const insertRelated = db.prepare("INSERT OR IGNORE INTO commit_sessions_related (hash, session_id) VALUES (?, ?)");
  const prefixed = (a: string, b: string) =>
    a === b || b.startsWith(a.endsWith("/") ? a : a + "/") || a.startsWith(b.endsWith("/") ? b : b + "/");

  // the same hash can be harvested from several worktrees — attribute it once,
  // but let every worktree path it was seen in compete for the match
  const reposByHash = new Map<string, Set<string>>();
  for (const c of mine) {
    if (!reposByHash.has(c.hash)) reposByHash.set(c.hash, new Set());
    reposByHash.get(c.hash)!.add(c.repo);
  }
  const uniqMine = [...new Map(mine.map((c) => [c.hash, c])).values()];
  db.exec("BEGIN");
  for (const c of uniqMine) {
    let best: ChSess | null = null;
    let bestSpec = -1;
    let bestDt = Infinity;
    const related: ChSess[] = [];
    const commitRepos = reposByHash.get(c.hash) ?? new Set([c.repo]);
    for (const s of sessions) {
      const start = Number(s.start_s);
      const end = Number(s.end_s);
      let spec = -1;
      for (const repo of commitRepos) {
        if (!prefixed(repo, s.ocwd)) continue;
        // specificity: exact worktree match beats repo-prefix containment
        const candidate = s.ocwd === repo ? 1e9 : Math.min(s.ocwd.length, repo.length);
        if (candidate > spec) spec = candidate;
      }
      if (spec < 0) continue;
      if (c.ts < start - 300 || c.ts > end + 1800) continue;
      related.push(s);
      const dt = Math.abs(c.ts - end);
      if (spec > bestSpec || (spec === bestSpec && dt < bestDt)) {
        best = s; bestSpec = spec; bestDt = dt;
      }
    }
    if (best) {
      insertMap.run(c.hash, best.sid);
      for (const s of related) if (s.sid !== best.sid) insertRelated.run(c.hash, s.sid);
    }
  }
  db.exec("COMMIT");

  const total = (db.prepare("SELECT COUNT(*) c FROM commits").get() as { c: number }).c;
  const mappedTotal = (db.prepare("SELECT COUNT(DISTINCT hash) c FROM commit_sessions").get() as { c: number }).c;
  console.log(`repos scanned: ${reposScanned}`);
  console.log(`commits found (mine, this run): ${mine.length} of ${all.length} total; db now ${total}`);
  console.log(`mapped to sessions: ${mappedTotal}/${total} (${total ? ((100 * mappedTotal) / total).toFixed(1) : 0}%)`);
  db.close();
}

// =================================================================================
// languages — per-session language + tooling stats
// =================================================================================

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python",
  rs: "Rust",
  go: "Go",
  md: "Markdown", mdx: "Markdown",
  json: "Config", jsonl: "Config", yaml: "Config", yml: "Config", toml: "Config", ini: "Config", env: "Config",
  css: "CSS", scss: "CSS", sass: "CSS", less: "CSS",
  html: "HTML", htm: "HTML",
  sql: "SQL",
  sh: "Shell", zsh: "Shell", bash: "Shell", fish: "Shell",
  swift: "Swift",
  c: "C/C++", cpp: "C/C++", cc: "C/C++", cxx: "C/C++", h: "C/C++", hpp: "C/C++", m: "C/C++", mm: "C/C++",
  java: "Java", kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  lua: "Lua",
  r: "R",
  glsl: "GLSL", vert: "GLSL", frag: "GLSL", wgsl: "GLSL", metal: "GLSL",
  proto: "Protobuf",
  tf: "Terraform",
  vue: "Vue", svelte: "Svelte",
  ipynb: "Notebook",
};

function langOf(p: string): string | null {
  const base = p.split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

const KNOWN_TOOLS = new Set([
  "uv", "pip", "pip3", "python", "python3", "cargo", "rustc", "bun", "bunx",
  "npm", "npx", "pnpm", "node", "pytest", "jest", "vitest", "go", "docker",
  "kubectl", "git", "gh", "make", "brew", "sqlite3", "clickhouse",
  "clickhouse-client", "curl",
]);
const TOOL_ALIAS: Record<string, string> = {
  pip3: "pip", python3: "python", bunx: "bun", npx: "npm", "clickhouse-client": "clickhouse",
};

// leading command word(s) per shell segment; env-var prefixes stripped
function toolWords(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = seg.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    let word = tokens[i];
    if (!word) continue;
    word = word.split("/").pop()!.toLowerCase();
    if (word.startsWith("mlx")) {
      out.push("mlx"); // mlx_lm.generate, mlx-vlm, mlx_lm.server, …
      continue;
    }
    if (KNOWN_TOOLS.has(word)) out.push(TOOL_ALIAS[word] ?? word);
  }
  return out;
}

async function runLanguages(): Promise<void> {
  const SINCE = "2026-01-01";
  const MAX_PATHS_PER_SESSION = 200;
  const MAX_CMDS_PER_SESSION = 500;

  // --- 1. file paths per session -----------------------------------------------
  // Payload shapes vary by harness: Claude {"input":{"file_path"}}, opencode
  // {"state":{"input":{"filePath"}}}, codex apply_patch {"input":"*** Update File: …"}.
  type FileRow = {
    session_id: string;
    tool_name: string;
    rrp: string;
    a: string; // input.file_path
    b: string; // input.filePath
    c: string; // state.input.filePath
    d: string; // top-level file_path
    e: string; // top-level path
    patch: string; // apply_patch's input string (truncated)
  };
  const fileRows = await ch<FileRow>(`
    SELECT session_id, tool_name, repo_rel_path AS rrp,
           JSONExtractString(payload_json,'input','file_path') AS a,
           JSONExtractString(payload_json,'input','filePath') AS b,
           JSONExtractString(payload_json,'state','input','filePath') AS c,
           JSONExtractString(payload_json,'file_path') AS d,
           JSONExtractString(payload_json,'path') AS e,
           substring(JSONExtractString(payload_json,'input'), 1, 4000) AS patch
    FROM events
    WHERE tool_name IN ('Read','Edit','Write','read','edit','write','apply_patch')
      AND is_substream = 0 AND event_ts > '${SINCE}'
    ORDER BY event_ts
    LIMIT ${MAX_PATHS_PER_SESSION} BY session_id
  `);
  console.log(`${fileRows.length} file-tool events`);

  const PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  const sessionLangs = new Map<string, Map<string, number>>();
  let classifiedPaths = 0;
  for (const r of fileRows) {
    const paths: string[] = [];
    const direct = r.a || r.b || r.c || r.d || r.e || r.rrp;
    if (direct) paths.push(direct);
    if (r.tool_name === "apply_patch" && r.patch.startsWith("***")) {
      for (const m of r.patch.matchAll(PATCH_FILE_RE)) paths.push(m[1].trim());
    }
    for (const p of paths) {
      const lang = langOf(p);
      if (!lang) continue;
      classifiedPaths++;
      let m = sessionLangs.get(r.session_id);
      if (!m) sessionLangs.set(r.session_id, (m = new Map()));
      m.set(lang, (m.get(lang) ?? 0) + 1);
    }
  }

  // --- 2. command tooling per session --------------------------------------------
  type CmdRow = {
    session_id: string;
    a: string; // input.command (Claude Bash)
    b: string; // state.input.command (opencode bash)
    c: string; // input as string (codex exec: js source calling exec_command)
    d: string; // arguments json-string (codex exec_command)
  };
  const cmdRows = await ch<CmdRow>(`
    SELECT session_id,
           substring(JSONExtractString(payload_json,'input','command'), 1, 120) AS a,
           substring(JSONExtractString(payload_json,'state','input','command'), 1, 120) AS b,
           substring(JSONExtractString(payload_json,'input'), 1, 300) AS c,
           substring(JSONExtractString(payload_json,'arguments'), 1, 300) AS d
    FROM events
    WHERE tool_name IN ('Bash','bash','exec','exec_command')
      AND is_substream = 0 AND event_ts > '${SINCE}'
    ORDER BY event_ts
    LIMIT ${MAX_CMDS_PER_SESSION} BY session_id
  `);
  console.log(`${cmdRows.length} shell-tool events`);

  const CMD_IN_JS_RE = /["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/;
  function commandOf(r: CmdRow): string | null {
    if (r.a) return r.a;
    if (r.b) return r.b;
    if (r.d) {
      try {
        const cmd = (JSON.parse(r.d) as { cmd?: string }).cmd;
        if (cmd) return cmd.slice(0, 120);
      } catch {
        const m = r.d.match(CMD_IN_JS_RE);
        if (m) return m[1].slice(0, 120);
      }
    }
    if (r.c && !r.c.startsWith("***")) {
      const m = r.c.match(CMD_IN_JS_RE);
      if (m) {
        try {
          return (JSON.parse(`"${m[1]}"`) as string).slice(0, 120);
        } catch {
          return m[1].slice(0, 120);
        }
      }
    }
    return null;
  }

  const sessionTools = new Map<string, Map<string, number>>();
  let parsedCmds = 0;
  for (const r of cmdRows) {
    const cmd = commandOf(r);
    if (!cmd) continue;
    parsedCmds++;
    for (const tool of toolWords(cmd)) {
      let m = sessionTools.get(r.session_id);
      if (!m) sessionTools.set(r.session_id, (m = new Map()));
      m.set(tool, (m.get(tool) ?? 0) + 1);
    }
  }

  // --- 3. write langs.sqlite ------------------------------------------------------
  const db = new DatabaseSync(join(exploreDir(), "langs.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS session_langs (
    session_id TEXT, lang TEXT, files INTEGER, PRIMARY KEY (session_id, lang)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS session_tools (
    session_id TEXT, tool TEXT, uses INTEGER, PRIMARY KEY (session_id, tool)
  )`);
  db.exec("DELETE FROM session_langs");
  db.exec("DELETE FROM session_tools");

  const insLang = db.prepare("INSERT OR REPLACE INTO session_langs (session_id, lang, files) VALUES (?, ?, ?)");
  const insTool = db.prepare("INSERT OR REPLACE INTO session_tools (session_id, tool, uses) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (const [sid, m] of sessionLangs) for (const [lang, files] of m) insLang.run(sid, lang, files);
  for (const [sid, m] of sessionTools) for (const [tool, uses] of m) insTool.run(sid, tool, uses);
  db.exec("COMMIT");

  const topOf = (maps: Map<string, Map<string, number>>) => {
    const agg = new Map<string, number>();
    for (const m of maps.values()) for (const [k, v] of m) agg.set(k, (agg.get(k) ?? 0) + v);
    return [...agg.entries()].sort((x, y) => y[1] - x[1]);
  };
  console.log(`sessions with language data: ${sessionLangs.size} (${classifiedPaths} classified paths)`);
  console.log(`sessions with tooling data:  ${sessionTools.size} (${parsedCmds} parsed commands)`);
  console.log("top languages:", topOf(sessionLangs).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", "));
  console.log("top tools:    ", topOf(sessionTools).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(", "));
  db.close();
}

// =================================================================================
// status — store counts + ClickHouse reachability
// =================================================================================

export function countIn(dbFile: string, sql: string): number | null {
  const path = join(exploreDir(), dbFile);
  if (!existsSync(path)) return null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    const n = (db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;
    db.close();
    return n;
  } catch {
    return null;
  }
}

async function runStatus(): Promise<void> {
  const rows: [string, number | null][] = [
    ["sessions scanned", countIn("scan.sqlite", "SELECT COUNT(*) c FROM session_scan")],
    ["clusters", countIn("scan.sqlite", "SELECT COUNT(*) c FROM clusters")],
    ["commits", countIn("commits.sqlite", "SELECT COUNT(*) c FROM commits")],
    ["commits mapped", countIn("commits.sqlite", "SELECT COUNT(DISTINCT hash) c FROM commit_sessions")],
    ["sessions with languages", countIn("langs.sqlite", "SELECT COUNT(DISTINCT session_id) c FROM session_langs")],
    ["sessions with tooling", countIn("langs.sqlite", "SELECT COUNT(DISTINCT session_id) c FROM session_tools")],
  ];
  console.log(`explore dir: ${exploreDir()}`);
  for (const [name, n] of rows) console.log(`${name}: ${n ?? "(no data)"}`);

  let chOk = false;
  try {
    const r = await ch<{ one: number }>("SELECT 1 AS one");
    chOk = r.length === 1;
  } catch { /* unreachable */ }
  console.log(`clickhouse (${clickhouseUrl()}): ${chOk ? "reachable" : "UNREACHABLE"}`);
  if (!chOk) process.exitCode = 1;
}

// =================================================================================
// registration
// =================================================================================

export function registerExploreCommand(program: Command): void {
  const explore = program
    .command("explore")
    .description("Scan local Moraine trace history into task labels, clusters, commits, and language stats.");

  explore
    .command("scan")
    .description(
      "Label + summarize sessions from Moraine ClickHouse via an OpenAI-compatible LLM " +
        "(including the desktop app's resident model). Writes scan.sqlite.",
    )
    .option("--limit <n>", "Max sessions to consider.", "500")
    .option("--concurrency <n>", "Parallel labeling workers.", "2")
    .option("--llm-url <url>", "OpenAI-compatible chat-completions endpoint.", DEFAULT_LLM_URL)
    .action(async (opts: { limit: string; concurrency: string; llmUrl: string }) => {
      await runScan({ limit: Number(opts.limit), concurrency: Number(opts.concurrency), llmUrl: opts.llmUrl });
    });

  explore
    .command("cluster")
    .description("Consolidate scan labels into canonical task clusters. Writes clusters + cluster_map.")
    .option("--llm-url <url>", "OpenAI-compatible chat-completions endpoint.", DEFAULT_LLM_URL)
    .action(async (opts: { llmUrl: string }) => {
      await runCluster({ llmUrl: opts.llmUrl });
    });

  explore
    .command("commits")
    .description("Harvest your git commits from repos seen in traces and attribute them to sessions. Writes commits.sqlite.")
    .action(async () => {
      await runCommits();
    });

  explore
    .command("languages")
    .description("Derive per-session language and tooling stats from file/shell tool events. Writes langs.sqlite.")
    .action(async () => {
      await runLanguages();
    });

  explore
    .command("mcp")
    .description(
      "Run a stdio MCP server over the local Moraine ClickHouse + explore scan stores " +
        "(drop-in for Moraine's MCP tool names, enriched with scan labels/clusters).",
    )
    .action(async () => {
      const { runExploreMcpServer } = await import("../explore-mcp.js");
      await runExploreMcpServer();
    });

  explore
    .command("mcp-install")
    .description(
      "Register `understudy explore mcp` as the `understudy` MCP server in agent configs, " +
        "replacing the `moraine` entry (Claude Code: ~/.claude.json). Backs up configs first.",
    )
    .option("--dry-run", "Print planned changes without writing.", false)
    .action(async (opts: { dryRun: boolean }) => {
      const { runExploreMcpInstall } = await import("../explore-mcp.js");
      await runExploreMcpInstall({ dryRun: Boolean(opts.dryRun) });
    });

  explore
    .command("status")
    .description("Show explore store counts and ClickHouse reachability (exit 1 if unreachable).")
    .action(async () => {
      await runStatus();
    });
}
