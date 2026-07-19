// Language + dev-environment layer for /timeline: derive per-session language
// stats (from file-tool paths) and tooling stats (from shell-tool commands)
// out of Moraine ClickHouse. Writes data/langs.sqlite (SEPARATE from
// scan.sqlite / commits.sqlite — no lock contention).
// Run: bun scripts/languages.ts   (idempotent — rebuilds both tables)

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const CLICKHOUSE = process.env.MORAINE_CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const SINCE = "2026-01-01";
const MAX_PATHS_PER_SESSION = 200;
const MAX_CMDS_PER_SESSION = 500;

async function ch<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${CLICKHOUSE}/?database=moraine&default_format=JSONEachRow`, {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as T) : [];
}

// --- extension → language -------------------------------------------------------
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

// --- known env/tooling command words --------------------------------------------
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

// --- 1. file paths per session ---------------------------------------------------
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

// --- 2. command tooling per session ----------------------------------------------
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

// --- 3. write langs.sqlite --------------------------------------------------------
mkdirSync(new URL("../data", import.meta.url).pathname, { recursive: true });
const db = new Database(new URL("../data/langs.sqlite", import.meta.url).pathname);
db.run(`CREATE TABLE IF NOT EXISTS session_langs (
  session_id TEXT, lang TEXT, files INTEGER, PRIMARY KEY (session_id, lang)
)`);
db.run(`CREATE TABLE IF NOT EXISTS session_tools (
  session_id TEXT, tool TEXT, uses INTEGER, PRIMARY KEY (session_id, tool)
)`);
db.run("DELETE FROM session_langs");
db.run("DELETE FROM session_tools");

const insLang = db.prepare("INSERT OR REPLACE INTO session_langs (session_id, lang, files) VALUES (?, ?, ?)");
const insTool = db.prepare("INSERT OR REPLACE INTO session_tools (session_id, tool, uses) VALUES (?, ?, ?)");
db.transaction(() => {
  for (const [sid, m] of sessionLangs) for (const [lang, files] of m) insLang.run(sid, lang, files);
  for (const [sid, m] of sessionTools) for (const [tool, uses] of m) insTool.run(sid, tool, uses);
})();

// --- stats ------------------------------------------------------------------------
const topOf = (maps: Map<string, Map<string, number>>) => {
  const agg = new Map<string, number>();
  for (const m of maps.values()) for (const [k, v] of m) agg.set(k, (agg.get(k) ?? 0) + v);
  return [...agg.entries()].sort((x, y) => y[1] - x[1]);
};
console.log(`sessions with language data: ${sessionLangs.size} (${classifiedPaths} classified paths)`);
console.log(`sessions with tooling data:  ${sessionTools.size} (${parsedCmds} parsed commands)`);
console.log("top languages:", topOf(sessionLangs).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("top tools:    ", topOf(sessionTools).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(", "));
