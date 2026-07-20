// Git-commit layer for /timeline: discover repos from Moraine ClickHouse,
// harvest 2026 commits, keep the user's own, and map them to agent sessions.
// Writes data/commits.sqlite (SEPARATE from scan.sqlite — no lock contention).
// Run: bun scripts/commits.ts   (idempotent / resumable)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";

const CLICKHOUSE = process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const MAX_REPOS = 100;

async function ch<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${CLICKHOUSE}/?database=moraine&default_format=JSONEachRow`, {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
}

function git(dir: string, args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString().trim();
  } catch {
    return null;
  }
}

// --- 1. discover candidate dirs from ClickHouse -------------------------------
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

// --- 2. harvest commits --------------------------------------------------------
mkdirSync(new URL("../data", import.meta.url).pathname, { recursive: true });
const db = new Database(new URL("../data/commits.sqlite", import.meta.url).pathname);
db.run(`CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  repo TEXT,
  ts INTEGER,
  author_email TEXT,
  subject TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS commit_sessions (
  hash TEXT,
  session_id TEXT,
  PRIMARY KEY (hash, session_id)
)`);

// the user's identities: git config user.email across repos + fuzzy "luis" names
const myEmails = new Set<string>();
for (const repo of repos) {
  const email = git(repo, ["config", "user.email"]);
  if (email) myEmails.add(email.toLowerCase());
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

// keep commits by the user (config emails ∪ fuzzy: name contains "luis")
const mine = all.filter((c) => myEmails.has(c.email) || c.name.toLowerCase().includes("luis"));
const insert = db.prepare(
  "INSERT OR IGNORE INTO commits (hash, repo, ts, author_email, subject) VALUES (?, ?, ?, ?, ?)",
);
const tx = db.transaction((cs: Commit[]) => {
  for (const c of cs) insert.run(c.hash, c.repo, c.ts, c.email, c.subject);
});
tx(mine);

// --- 3. map commits → sessions -------------------------------------------------
// alias names differ from column names (ClickHouse alias-shadowing bug)
type Sess = { sid: string; ocwd: string; start_s: string; end_s: string };
const sessions = await ch<Sess>(`
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
db.run(`CREATE TABLE IF NOT EXISTS commit_sessions_related (
  hash TEXT, session_id TEXT, PRIMARY KEY (hash, session_id)
)`);
db.run("DELETE FROM commit_sessions");
db.run("DELETE FROM commit_sessions_related");
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
const txMap = db.transaction(() => {
  for (const c of uniqMine) {
    let best: Sess | null = null;
    let bestSpec = -1;
    let bestDt = Infinity;
    const related: Sess[] = [];
    const repos = reposByHash.get(c.hash) ?? new Set([c.repo]);
    for (const s of sessions) {
      const start = Number(s.start_s);
      const end = Number(s.end_s);
      let spec = -1;
      for (const repo of repos) {
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
});
txMap();

const total = (db.query("SELECT COUNT(*) c FROM commits").get() as { c: number }).c;
const mappedTotal = (db.query("SELECT COUNT(DISTINCT hash) c FROM commit_sessions").get() as { c: number }).c;
console.log(`repos scanned: ${reposScanned}`);
console.log(`commits found (mine, this run): ${mine.length} of ${all.length} total; db now ${total}`);
console.log(`mapped to sessions: ${mappedTotal}/${total} (${total ? ((100 * mappedTotal) / total).toFixed(1) : 0}%)`);
